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
)

class PhoneViewModel(application: Application) : AndroidViewModel(application) {
    private val credentials = DeviceCredentialStore(application)
    private val local = ConversationStore(credentials)
    private val _state = MutableStateFlow(PhoneUiState(hostUrl = credentials.hostUrl.orEmpty(),
        paired = credentials.token() != null, threads = local.data.threads, pending = local.data.pending))
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
        val projects = api.projects(); val catalog = api.models()
        val page = api.threads(before.selectedProjectId, search = before.query)
        val approvals = if (capabilities?.capabilities?.contains("global-approvals") == true) api.approvals() else emptyList()
        val detail = before.selectedThreadId?.let { api.thread(it) }
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
                hostVersion = capabilities?.hostVersion, error = null)
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
                _state.update { it.copy(threads = (it.threads + page.threads).distinctBy(ThreadSummary::id), nextCursor = page.nextCursor) }
            }
        }
    }
    fun openThread(id: String) {
        persistDraft()
        extendedHistory.remove(id)
        _state.update { it.copy(selectedThreadId = id, composingNew = false, selectedThread = local.data.details.find { d -> d.thread.id == id },
            draft = local.draft(id), error = null, model = null, effort = null) }
        work {
            val session = epoch; val detail = connection().thread(id)
            if (session == epoch && _state.value.selectedThreadId == id) {
                _state.update { it.copy(selectedThread = detail, model = detail.model, effort = detail.effort) }
                local.cache(_state.value.threads, detail); saveLocal()
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
                it.copy(selectedThread = current.copy(turns = (more.turns + current.turns).distinctBy(ThreadTurn::id).sortedBy { turn -> turn.startedAt ?: 0 }, nextCursor = more.nextCursor))
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
    fun send(steer: Boolean = false) {
        val s = _state.value
        if (s.sending || s.pending != null || s.draft.isBlank() || !s.supportsSafeSend) return
        if (s.composingNew && s.projects.none { it.id == s.selectedProjectId && it.canStart }) {
            _state.update { it.copy(error = "请先在电脑端登记允许启动任务的项目") }; return
        }
        val pending = PendingSubmission(UUID.randomUUID().toString(), s.selectedThreadId, if (s.composingNew) s.selectedProjectId else null,
            s.draft.trim(), s.model, s.effort, if (steer) "steer" else "send")
        _state.update { it.copy(sending = true, error = null) }
        work(false) {
            withContext(Dispatchers.IO) { local.pending(pending) }
            _state.update { it.copy(pending = pending, pendingStatus = "running") }; dispatch(pending)
        }
    }
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
        if (local.draft(key).trim() == pending.prompt) local.draft(key, "")
        withContext(Dispatchers.IO) { local.pending(null) }
        _state.update {
            val same = it.selectedThreadId == pending.threadId && (pending.threadId != null || it.composingNew)
            it.copy(pending = null, pendingStatus = null, error = null, notice = "电脑已接收",
                selectedThreadId = if (same) id else it.selectedThreadId,
                composingNew = if (same && id != null) false else it.composingNew,
                draft = if (same && it.draft.trim() == pending.prompt) "" else it.draft)
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
    fun disconnect() {
        if (_state.value.sending) return
        work { credentials.deviceId?.let { connection().revoke(it) }; clearConnection() }
    }
    fun forgetLocally() { if (!_state.value.sending) clearConnection() }
    private fun clearConnection() {
        epoch++; eventJob?.cancel(); pollJob?.cancel(); syncJob?.cancel(); draftJob?.cancel()
        extendedThreads = false; extendedHistory.clear()
        viewModelScope.coroutineContext.cancelChildren()
        local.clear(); api = null; _state.value = PhoneUiState(hostUrl = credentials.hostUrl.orEmpty())
    }
    fun imageApi(): CodexPhoneApi? = runCatching { connection() }.getOrNull()
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
        "无法连接电脑。请检查 Tailscale、电脑共享连接和地址。",
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
