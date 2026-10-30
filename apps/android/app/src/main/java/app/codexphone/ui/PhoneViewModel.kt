package app.codexphone.ui

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import app.codexphone.data.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.*
import java.util.UUID

data class PhoneUiState(
    val hostUrl: String = "", val paired: Boolean = false, val busy: Boolean = false, val sending: Boolean = false,
    val error: String? = null, val notice: String? = null, val hostStatus: HostStatus? = null,
    val projects: List<Project> = emptyList(), val threads: List<ThreadSummary> = emptyList(),
    val selectedProjectId: String? = null, val selectedThread: ThreadDetail? = null,
    val selectedThreadId: String? = null, val composingNew: Boolean = false,
    val nextCursor: String? = null, val query: String = "", val draft: String = "",
    val models: List<ModelOption> = emptyList(), val model: String? = null, val effort: String? = null,
    val approvals: List<ApprovalRequest> = emptyList(), val pending: PendingSubmission? = null,
    val pendingStatus: String? = null, val supportsSafeSend: Boolean = false, val realtime: Boolean = false,
    val hostVersion: String? = null,
    val accountsUrl: String = "", val username: String = "",
    val rememberedServers: List<RememberedAccountServer> = emptyList(),
    val supportsQueue: Boolean = false, val queued: List<QueuedMessage> = emptyList(),
)

class PhoneViewModel(application: Application) : AndroidViewModel(application) {
    private val credentials = DeviceCredentialStore(application)
    private val local = ConversationStore(credentials)
    private val _state = MutableStateFlow(PhoneUiState(hostUrl = credentials.hostUrl.orEmpty(), accountsUrl = credentials.accountsUrl.orEmpty(), username = credentials.username.orEmpty(),
        paired = credentials.token() != null, threads = local.data.threads, pending = local.data.pending, rememberedServers = credentials.rememberedServers(),
        notice = if (credentials.recoveredData) "已跳过异常对话缓存，登录和草稿已保留。未确认的指令请先检查电脑。" else null))
    val state = _state.asStateFlow()
    private var api: CodexPhoneApi? = null
    private var epoch = 0
    private var eventJob: Job? = null
    private var pollJob: Job? = null
    private var syncJob: Job? = null
    private var draftJob: Job? = null
    private var foreground = false
    private var extendedThreads = false
    private val extendedHistory = mutableSetOf<String>()
    private val syncMutex = Mutex()
    fun editHost(value: String) { if (!_state.value.paired) _state.update { it.copy(hostUrl = value, error = null) } }
    fun editAccounts(value: String) { if (!_state.value.paired) _state.update { it.copy(accountsUrl = value, error = null) } }
    fun login(username: String, password: String) {
        if (_state.value.busy) return
        work {
            val accounts = CodexPhoneApi(_state.value.accountsUrl)
            val login = accounts.login(username.trim(), password, credentials.installationId, (android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL).take(60))
            val host = login.host ?: error("账号尚未绑定电脑，请先在电脑管理中心完成绑定")
            val computer = CodexPhoneApi(host.url); val session = computer.connectAccount(login.token)
            withContext(Dispatchers.IO) {
                credentials.saveSession(computer.baseUrl.toString(), session.token, session.deviceId)
                credentials.saveAccount(accounts.baseUrl.toString(), login.account.username, login.token)
            }
            api = CodexPhoneApi(computer.baseUrl.toString(), session.token)
            _state.update { it.copy(paired = true, hostUrl = computer.baseUrl.toString(), accountsUrl = accounts.baseUrl.toString().trimEnd('/'), username = login.account.username, rememberedServers = credentials.rememberedServers()) }
            try { refreshNow() } finally { startRealtime() }
        }
    }
    fun selectAccountServer(server: RememberedAccountServer) {
        if (_state.value.paired || _state.value.busy) return
        credentials.selectAccountServer(server)
        _state.update { it.copy(accountsUrl = server.url, username = server.username, error = null) }
    }
    fun removeRememberedServer(server: RememberedAccountServer) {
        if (_state.value.paired || _state.value.busy) return
        credentials.removeRememberedServer(server.url, server.username)
        _state.update { it.copy(accountsUrl = credentials.accountsUrl.orEmpty(), username = credentials.username.orEmpty(), rememberedServers = credentials.rememberedServers()) }
    }
    private fun connection(): CodexPhoneApi = api ?: CodexPhoneApi(
        credentials.hostUrl ?: error("请先配对电脑"), credentials.token() ?: error("请重新配对电脑")
    ).also { api = it }

    fun pair(code: String) {
        if (_state.value.busy) return
        val address = _state.value.hostUrl.trim()
        if (address.isBlank() || code.isBlank()) { _state.update { it.copy(error = "填写电脑地址和一次性配对码") }; return }
        work {
            val candidate = CodexPhoneApi(address)
            val status = candidate.health()
            if (status.status != "ready") error(status.lastError ?: "电脑端还未准备好")
            val result = candidate.pair(code, (android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL).take(60))
            credentials.saveSession(candidate.baseUrl.toString(), result.token, result.deviceId)
            api = CodexPhoneApi(candidate.baseUrl.toString(), result.token)
            _state.update { it.copy(paired = true, hostUrl = candidate.baseUrl.toString(), hostStatus = status, error = null) }
            try { refreshNow() } finally { startRealtime() }
        }
    }
    fun setForeground(active: Boolean) {
        foreground = active
        if (!active) {
            eventJob?.cancel(); eventJob = null; pollJob?.cancel(); syncJob?.cancel()
            _state.update { it.copy(realtime = false) }; saveLocal()
        } else if (_state.value.paired) { refresh(); startRealtime() }
    }
    private fun startRealtime() {
        if (!foreground || !_state.value.paired || eventJob?.isActive == true) return
        val session = epoch
        eventJob = viewModelScope.launch {
            var wait = 1000L
            while (isActive && session == epoch) {
                try {
                    connection().events().collect { event ->
                        if (session != epoch) return@collect
                        when (event["type"]?.jsonPrimitive?.contentOrNull) {
                            "connected" -> { wait = 1000; _state.update { it.copy(realtime = true) }; scheduleSync() }
                            "agent-delta" -> {
                                val threadId = event["threadId"]?.jsonPrimitive?.contentOrNull
                                val itemId = event["itemId"]?.jsonPrimitive?.contentOrNull
                                val turnId = event["turnId"]?.jsonPrimitive?.contentOrNull
                                val delta = event["delta"]?.jsonPrimitive?.contentOrNull
                                if (threadId != null && turnId != null && itemId != null && delta != null)
                                    _state.update { it.copy(selectedThread = applyDelta(it.selectedThread, threadId, turnId, itemId, delta)) }
                                scheduleSync(1800)
                            }
                            else -> scheduleSync()
                        }
                    }
                } catch (e: CancellationException) { throw e }
                catch (e: Exception) {
                    _state.update { it.copy(realtime = false) }
                    if (e is ApiException && e.code == 401) {
                        _state.update { it.copy(error = "配对已失效，请在设置中移除此连接后重新配对") }; break
                    }
                }
                _state.update { it.copy(realtime = false) }; delay(wait); wait = (wait * 2).coerceAtMost(15_000)
            }
        }
        pollJob?.cancel()
        pollJob = viewModelScope.launch {
            while (isActive && session == epoch) {
                delay(8000)
                try { refreshNow() } catch (e: CancellationException) { throw e } catch (_: Exception) {}
            }
        }
    }
    private fun scheduleSync(wait: Long = 400) {
        if (syncJob?.isActive == true) return
        syncJob = viewModelScope.launch {
            delay(wait)
            try { refreshNow() } catch (e: CancellationException) { throw e } catch (_: Exception) {}
        }
    }
    fun refresh() = work { refreshNow() }
    private suspend fun refreshNow() = syncMutex.withLock {
        val session = epoch; val api = connection(); val before = _state.value
        val health = api.health()
        if (session != epoch) return@withLock
        _state.update { it.copy(hostStatus = health) }
        val capabilities = try { api.capabilities() } catch (e: ApiException) { if (e.code == 404) null else throw e }
        val projects = api.projects().filter { it.id.isNotBlank() }.distinctBy { it.id }; val catalog = api.models()
        val received = api.threads(before.selectedProjectId, search = before.query)
        val page = received.copy(threads = LocalDataPolicy.threads(received.threads))
        val approvals = if (capabilities?.capabilities?.contains("global-approvals") == true) api.approvals() else emptyList()
        val detail = before.selectedThreadId?.let { api.thread(it) }
        val supportsQueue = capabilities?.capabilities?.contains("message-queue") == true
        val queued = if (supportsQueue && before.selectedThreadId != null) api.queue(before.selectedThreadId) else emptyList()
        if (session != epoch) return@withLock
        _state.update { current ->
            val sameFilter = current.selectedProjectId == before.selectedProjectId && current.query == before.query
            val chosen = current.model ?: detail?.model ?: catalog.defaultModel.takeIf(String::isNotBlank)
            val option = catalog.models.find { it.id == chosen }
            val effort = (current.effort ?: detail?.effort)?.takeIf { it in option?.efforts.orEmpty() } ?: option?.defaultEffort?.takeIf(String::isNotBlank)
            current.copy(hostStatus = health, projects = projects, models = catalog.models, model = chosen, effort = effort,
                threads = if (sameFilter) {
                    if (extendedThreads) (page.threads + current.threads).distinctBy(ThreadSummary::id) else page.threads
                } else current.threads,
                nextCursor = if (sameFilter && !extendedThreads) page.nextCursor else current.nextCursor,
                selectedThread = if (current.selectedThreadId == before.selectedThreadId && detail != null)
                    mergeHistory(current.selectedThread, detail, detail.thread.id in extendedHistory) else current.selectedThread,
                approvals = approvals, supportsSafeSend = capabilities?.capabilities?.contains("idempotent-send") == true,
                hostVersion = capabilities?.hostVersion, supportsQueue = supportsQueue,
                queued = if (current.selectedThreadId == before.selectedThreadId) queued else current.queued, error = null)
        }
        local.cache(_state.value.threads, _state.value.selectedThread)
        withContext(Dispatchers.IO) { local.persist() }
        reconcilePending()
    }
    fun selectProject(id: String?) {
        extendedThreads = false
        persistDraft(); _state.update { it.copy(selectedProjectId = id, threads = emptyList(), nextCursor = null) }; refresh()
    }
    fun search(value: String) {
        extendedThreads = false
        _state.update { it.copy(query = value) }; syncJob?.cancel()
        syncJob = viewModelScope.launch {
            delay(350); try { refreshNow() } catch (e: CancellationException) { throw e } catch (e: Exception) { failure(e) }
        }
    }
    fun loadMoreThreads() {
        val snapshot = _state.value; val cursor = snapshot.nextCursor ?: return
        work {
            val page = connection().threads(snapshot.selectedProjectId, cursor, snapshot.query)
            if (_state.value.selectedProjectId == snapshot.selectedProjectId && _state.value.query == snapshot.query) {
                extendedThreads = true
                _state.update { it.copy(threads = LocalDataPolicy.threads(it.threads + page.threads), nextCursor = page.nextCursor) }
            }
        }
    }
    fun openThread(id: String) {
        persistDraft()
        extendedHistory.remove(id)
        _state.update { it.copy(selectedThreadId = id, composingNew = false, selectedThread = local.data.details.find { d -> d.thread.id == id },
            draft = local.draft(id), error = null, model = null, effort = null, queued = emptyList()) }
        work {
            val session = epoch; val detail = connection().thread(id)
            if (session == epoch && _state.value.selectedThreadId == id) {
                _state.update { it.copy(selectedThread = detail, model = detail.model, effort = detail.effort) }
                local.cache(_state.value.threads, detail); saveLocal()
                if (_state.value.supportsQueue) {
                    val messages = connection().queue(id)
                    if (session == epoch && _state.value.selectedThreadId == id) _state.update { it.copy(queued = messages) }
                }
            }
        }
    }
    fun loadEarlier() {
        val snapshot = _state.value.selectedThread ?: return; val cursor = snapshot.nextCursor ?: return
        work {
            val more = connection().thread(snapshot.thread.id, cursor)
            if (_state.value.selectedThreadId == snapshot.thread.id) {
                extendedHistory.add(snapshot.thread.id)
                _state.update {
                val current = it.selectedThread ?: return@update it
                it.copy(selectedThread = current.copy(turns = (more.turns + current.turns).distinctBy(ThreadTurn::id), nextCursor = more.nextCursor))
                }
            }
        }
    }
    fun newTask() {
        persistDraft()
        _state.update { it.copy(composingNew = true, selectedThread = null, selectedThreadId = null, draft = local.draft("new"),
            selectedProjectId = it.selectedProjectId?.takeIf { id -> it.projects.any { p -> p.id == id && p.canStart } } ?: it.projects.firstOrNull(Project::canStart)?.id, error = null) }
    }
    fun closeThread() {
        persistDraft(); saveLocal()
        _state.update { it.copy(selectedThreadId = null, selectedThread = null, composingNew = false, draft = "", error = null) }
    }
    fun editDraft(value: String) {
        _state.update { it.copy(draft = value.take(20_000)) }; persistDraft(); draftJob?.cancel()
        draftJob = viewModelScope.launch { delay(400); saveLocal() }
    }
    private fun persistDraft() {
        val s = _state.value
        if (s.composingNew || s.selectedThreadId != null) local.draft(s.selectedThreadId ?: "new", s.draft)
    }
    fun chooseModel(id: String?) {
        val option = _state.value.models.find { it.id == id }
        _state.update { it.copy(model = id, effort = option?.defaultEffort?.takeIf(String::isNotBlank)) }
    }
    fun chooseEffort(effort: String) { _state.update { it.copy(effort = effort) } }
    fun send() {
        val s = _state.value
        if (s.sending || s.pending != null || s.draft.isBlank() || !s.supportsSafeSend) return
        val shouldQueue = s.selectedThread?.thread?.activeTurnId != null
        if (shouldQueue && !s.supportsQueue) { _state.update { it.copy(error = "请升级电脑 Host 至 0.2.1 后使用排队发送") }; return }
        if (s.composingNew && s.projects.none { it.id == s.selectedProjectId && it.canStart }) {
            _state.update { it.copy(error = "请先在电脑端登记允许启动任务的项目") }; return
        }
        val pending = PendingSubmission(UUID.randomUUID().toString(), s.selectedThreadId, if (s.composingNew) s.selectedProjectId else null,
            s.draft.trim(), s.model, s.effort, if (shouldQueue) "queue" else "send")
        _state.update { it.copy(sending = true, error = null) }
        work(false) {
            withContext(Dispatchers.IO) { local.pending(pending) }
            _state.update { it.copy(pending = pending, pendingStatus = "running") }; dispatch(pending)
        }
    }
    fun guideQueued(message: QueuedMessage) {
        val s = _state.value
        if (s.sending || s.pending != null || message.state != "queued") return
        val pending = PendingSubmission(UUID.randomUUID().toString(), message.threadId, null, message.prompt, null, null, "guide:" + message.id)
        _state.update { it.copy(sending = true, error = null) }
        work(false) {
            withContext(Dispatchers.IO) { local.pending(pending) }
            _state.update { it.copy(pending = pending, pendingStatus = "running") }; dispatch(pending)
        }
    }
    fun cancelQueued(message: QueuedMessage) = work { connection().cancelQueued(message.threadId, message.id); refreshNow() }
    fun retryPending() {
        val pending = _state.value.pending ?: return
        if (_state.value.sending) return
        if (System.currentTimeMillis() - pending.createdAt > 6 * 86400_000L) {
            _state.update { it.copy(error = "该请求已超出去重查询期限，请检查电脑对话后手动处理", pendingStatus = "unknown") }; return
        }
        _state.update { it.copy(sending = true) }; work(false) { dispatch(pending) }
    }
    private suspend fun dispatch(pending: PendingSubmission) {
        val session = epoch
        try { completeSubmission(pending, connection().submit(pending)) }
        catch (e: CancellationException) { throw e }
        catch (_: Exception) {
            _state.update { it.copy(error = "提交结果尚未确认。请查询状态或查看对话；不要另发相同内容。", pendingStatus = "unknown") }
            runCatching { reconcilePending() }
        } finally { if (session == epoch) _state.update { it.copy(sending = false) } }
    }
    fun checkPending() = work { reconcilePending() }
    fun viewPendingConversation() {
        val pending = _state.value.pending ?: return
        if (pending.threadId != null) openThread(pending.threadId) else newTask()
    }
    private suspend fun reconcilePending() {
        val pending = _state.value.pending ?: return
        try {
            val operation = connection().operation(pending.requestId)
            when (val status = operation["state"]?.jsonPrimitive?.contentOrNull) {
                "completed" -> completeSubmission(pending, operation["result"]?.jsonObject ?: JsonObject(emptyMap()))
                "failed" -> _state.update { it.copy(pendingStatus = "failed", error = operation["error"]?.jsonPrimitive?.contentOrNull ?: "电脑未完成本次提交，请检查对话") }
                else -> _state.update { it.copy(pendingStatus = status ?: "unknown") }
            }
        } catch (e: ApiException) {
            if (e.code == 404) _state.update { it.copy(pendingStatus = "not-found", error = "电脑尚未记录这次提交。可以使用原请求编号安全重试。") }
            else throw e
        }
    }
    private suspend fun completeSubmission(pending: PendingSubmission, result: JsonObject) {
        if (_state.value.pending?.requestId != pending.requestId) return
        val id = result["threadId"]?.jsonPrimitive?.contentOrNull ?: pending.threadId
        val key = pending.threadId ?: "new"
        val clearDraft = !pending.kind.startsWith("guide:")
        if (clearDraft && local.draft(key).trim() == pending.prompt) local.draft(key, "")
        withContext(Dispatchers.IO) { local.pending(null) }
        _state.update {
            val same = it.selectedThreadId == pending.threadId && (pending.threadId != null || it.composingNew)
            it.copy(pending = null, pendingStatus = null, error = null, notice = "电脑已接收",
                selectedThreadId = if (same) id else it.selectedThreadId,
                composingNew = if (same && id != null) false else it.composingNew,
                draft = if (clearDraft && same && it.draft.trim() == pending.prompt) "" else it.draft)
        }; scheduleSync()
    }
    fun dismissPendingAfterReview() {
        local.pending(null); _state.update { it.copy(pending = null, pendingStatus = null, error = null) }
    }
    fun interrupt() {
        val thread = _state.value.selectedThread?.thread ?: return; val turn = thread.activeTurnId ?: return
        work { connection().interrupt(thread.id, turn); refreshNow() }
    }
    fun favorite(thread: ThreadSummary) = work { connection().favorite(thread.id, !thread.isPinned); refreshNow() }
    fun answer(approval: ApprovalRequest, decision: String? = null, answers: Map<String, String> = emptyMap()) = work {
        try { connection().approve(approval.id, decision, answers) }
        catch (e: ApiException) { if (e.code != 409) throw e else _state.update { it.copy(notice = "该请求已在其他设备处理") } }
        refreshNow()
    }
    fun logout() {
        if (_state.value.sending || _state.value.busy) return
        val session = epoch
        _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            var remoteError: Exception? = null
            try {
                withContext(NonCancellable) {
                    runCatching { credentials.deviceId?.let { connection().revoke(it) } }
                        .onFailure { remoteError = it as? Exception }
                    val url = credentials.accountsUrl; val token = credentials.accountToken()
                    if (url != null && token != null) {
                        runCatching { CodexPhoneApi(url, token).logoutAccount() }
                            .onFailure { if (remoteError == null) remoteError = it as? Exception }
                    }
                    credentials.clearToken()
                    clearConnection(cancelPendingOperations = false)
                }
                if (remoteError != null) _state.update { it.copy(notice = "已退出登录。本机凭据已清除，但电脑暂时无法确认撤销；可在电脑管理中心移除此设备。") }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                if (session == epoch) failure(e)
            } finally {
                if (session == epoch) _state.update { it.copy(busy = false) }
            }
        }
    }
    fun forgetLocally() { if (!_state.value.sending) clearConnection() }
    private fun clearConnection(cancelPendingOperations: Boolean = true) {
        epoch++; eventJob?.cancel(); pollJob?.cancel(); syncJob?.cancel(); draftJob?.cancel()
        extendedThreads = false; extendedHistory.clear()
        if (cancelPendingOperations) viewModelScope.coroutineContext.cancelChildren()
        local.clear(); api = null; _state.value = PhoneUiState(hostUrl = credentials.hostUrl.orEmpty(), accountsUrl = credentials.accountsUrl.orEmpty(), username = credentials.username.orEmpty(), rememberedServers = credentials.rememberedServers())
    }
    fun imageApi(): CodexPhoneApi? = runCatching { connection() }.getOrNull()
    fun resetDisplayCache() = work {
        withContext(Dispatchers.IO) { local.clearDisplayCache() }
        _state.update { it.copy(threads = emptyList(), selectedThread = null, selectedThreadId = null,
            notice = "对话缓存已重置，登录、草稿和未确认指令已保留。") }
        refreshNow()
    }
    private fun saveLocal() { viewModelScope.launch(Dispatchers.IO) { runCatching { local.persist() } } }
    private fun work(showBusy: Boolean = true, block: suspend () -> Unit) {
        val session = epoch
        if (showBusy) _state.update { it.copy(busy = true, error = null) }
        viewModelScope.launch {
            try { block() } catch (e: CancellationException) { throw e }
            catch (e: Exception) { if (session == epoch) failure(e) }
            finally { if (session == epoch) _state.update { it.copy(busy = false, sending = if (showBusy) it.sending else false) } }
        }
    }
    private fun failure(e: Exception) { _state.update { it.copy(error = if (e is ApiException) e.message else
        e.message?.takeIf { e is java.io.IOException } ?: "操作未完成，请检查 Tailscale、账号服务和电脑连接。",
        hostStatus = if (e is ApiException) it.hostStatus else it.hostStatus?.copy(status = "degraded")) } }
}

fun mergeHistory(current: ThreadDetail?, fresh: ThreadDetail, extended: Boolean): ThreadDetail {
    if (!extended || current?.thread?.id != fresh.thread.id) return fresh
    val latest = fresh.turns.associateBy(ThreadTurn::id)
    val turns = current.turns.map { latest[it.id] ?: it } + fresh.turns.filter { incoming -> current.turns.none { it.id == incoming.id } }
    return fresh.copy(turns = turns, nextCursor = current.nextCursor)
}

fun applyDelta(detail: ThreadDetail?, threadId: String, turnId: String, itemId: String, delta: String): ThreadDetail? {
    if (detail == null || detail.thread.id != threadId) return detail
    val turns = detail.turns.toMutableList()
    var index = turns.indexOfFirst { it.id == turnId }
    if (index == -1) { turns.add(ThreadTurn(turnId, "inProgress")); index = turns.lastIndex }
    val turn = turns[index]; val items = turn.items.toMutableList(); val i = items.indexOfFirst { it.id == itemId }
    if (i == -1) items.add(ThreadItem(itemId, "agentMessage", delta, status = "inProgress"))
    else items[i] = items[i].copy(text = items[i].text + delta)
    turns[index] = turn.copy(items = items)
    return detail.copy(turns = turns)
}
