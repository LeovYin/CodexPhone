package app.codexphone.ui

import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.*
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Chat
import androidx.compose.material.icons.automirrored.filled.Send
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.*
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.*
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.*
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.*
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import app.codexphone.BuildConfig
import app.codexphone.data.*
import coil.ImageLoader
import coil.compose.SubcomposeAsyncImage
import coil.decode.SvgDecoder
import coil.request.ImageRequest
import kotlinx.coroutines.launch
import kotlinx.coroutines.flow.first

private val Ink = Color(0xFF17223B)
private val Muted = Color(0xFF65718A)
private val Line = Color(0xFFE5EAF3)
private val Blue = Color(0xFF315FCA)
private val Background = Color(0xFFF4F7FF)

@Composable
fun CodexPhoneApp(vm: PhoneViewModel) {
    val state by vm.state.collectAsStateWithLifecycle()
    var tab by rememberSaveable { mutableIntStateOf(0) }
    var confirmForget by remember { mutableStateOf(false) }
    BackHandler(state.selectedThreadId != null || state.composingNew) { vm.closeThread() }
    when {
        !state.paired -> PairScreen(state, vm)
        state.selectedThreadId != null || state.composingNew -> ConversationScreen(state, vm)
        else -> Scaffold(containerColor = Background, contentWindowInsets = WindowInsets(0, 0, 0, 0),
            bottomBar = {
                NavigationBar(containerColor = Color.White) {
                    NavigationBarItem(tab == 0, { tab = 0 }, icon = { Icon(Icons.AutoMirrored.Filled.Chat, null) }, label = { Text("任务") })
                    NavigationBarItem(tab == 1, { tab = 1 }, icon = {
                        BadgedBox(badge = { if (state.approvals.isNotEmpty()) Badge { Text(state.approvals.size.toString()) } }) {
                            Icon(Icons.Default.TaskAlt, null)
                        }
                    }, label = { Text("待处理") })
                    NavigationBarItem(tab == 2, { tab = 2 }, icon = { Icon(Icons.Default.Settings, null) }, label = { Text("设置") })
                }
            }) { padding ->
            when (tab) {
                1 -> ApprovalInbox(state, vm, Modifier.padding(padding))
                2 -> SettingsScreen(state, vm, { confirmForget = true }, Modifier.padding(padding))
                else -> ThreadListScreen(state, vm, Modifier.padding(padding))
            }
        }
    }
    if (confirmForget) AlertDialog(onDismissRequest = { confirmForget = false }, title = { Text("移除此电脑连接？") },
        text = { Text("会清除手机上的凭据、缓存与草稿。若无法连接电脑，电脑端的设备授权仍需在电脑上撤销。") },
        confirmButton = { TextButton({ confirmForget = false; vm.forgetLocally() }) { Text("清除本机连接") } },
        dismissButton = { TextButton({ confirmForget = false }) { Text("取消") } })
}

@Composable private fun PairScreen(s: PhoneUiState, vm: PhoneViewModel) {
    var code by remember { mutableStateOf("") }
    Column(Modifier.fillMaxSize().background(Background).statusBarsPadding().navigationBarsPadding()
        .imePadding().verticalScroll(rememberScrollState()).padding(24.dp)) {
        Spacer(Modifier.height(36.dp))
        Box(Modifier.size(64.dp).clip(RoundedCornerShape(19.dp)).background(Blue), contentAlignment = Alignment.Center) {
            Text(">_", color = Color.White, fontSize = 28.sp, fontWeight = FontWeight.Bold)
        }
        Spacer(Modifier.height(24.dp))
        Text("电脑上的任务，\n随身继续。", fontSize = 29.sp, lineHeight = 38.sp, color = Ink, fontWeight = FontWeight.Bold)
        Text("先打开手机 Tailscale，再启动电脑上的共享连接。", Modifier.padding(top = 12.dp, bottom = 28.dp), color = Muted, lineHeight = 22.sp)
        OutlinedTextField(s.hostUrl, vm::editHost, Modifier.fillMaxWidth(), label = { Text("电脑地址") },
            placeholder = { Text("http://100.x.x.x:4318") }, singleLine = true,
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri), enabled = !s.busy)
        Spacer(Modifier.height(12.dp))
        OutlinedTextField(code, { code = it }, Modifier.fillMaxWidth(), label = { Text("一次性配对码") },
            singleLine = true, visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(autoCorrectEnabled = false), enabled = !s.busy)
        Button({ vm.pair(code) }, Modifier.fillMaxWidth().padding(top = 20.dp).height(52.dp), enabled = !s.busy) {
            if (s.busy) CircularProgressIndicator(Modifier.size(22.dp), color = Color.White, strokeWidth = 2.dp) else Text("配对并连接")
        }
        s.error?.let { ErrorMessage(it) }
        Text("使用你电脑上原有的模型配置。手机只保存加密的设备凭据。", Modifier.padding(top = 18.dp), color = Muted, fontSize = 13.sp, lineHeight = 20.sp)
        Text("CodexPhone " + BuildConfig.VERSION_NAME, Modifier.padding(top = 24.dp), color = Muted, fontSize = 12.sp)
    }
}

@Composable private fun Header(title: String, subtitle: String, s: PhoneUiState, vm: PhoneViewModel) {
    Row(Modifier.fillMaxWidth().statusBarsPadding().padding(start = 20.dp, top = 16.dp, end = 8.dp, bottom = 14.dp),
        verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            Text(title, color = Ink, fontSize = 25.sp, fontWeight = FontWeight.Bold)
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(top = 6.dp)) {
                Box(Modifier.size(7.dp).clip(CircleShape).background(if (s.realtime) Color(0xFF259875) else Color(0xFFCA913A)))
                Text(subtitle, Modifier.padding(start = 7.dp), color = Muted, fontSize = 12.sp)
            }
        }
        IconButton(vm::refresh, enabled = !s.busy) {
            if (s.busy) CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp) else Icon(Icons.Default.Refresh, "刷新")
        }
    }
}
@Composable private fun ThreadListScreen(s: PhoneUiState, vm: PhoneViewModel, modifier: Modifier) {
    Column(modifier.fillMaxSize()) {
        Header("CodexPhone", if (s.realtime) "与电脑实时同步" else "等待连接 · 缓存可浏览", s, vm)
        Row(Modifier.padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
            OutlinedTextField(s.query, vm::search, Modifier.weight(1f), placeholder = { Text("搜索电脑对话") },
                singleLine = true, leadingIcon = { Icon(Icons.Default.Search, null) }, shape = RoundedCornerShape(14.dp))
            Spacer(Modifier.width(8.dp))
            FilledIconButton(vm::newTask, Modifier.size(52.dp)) { Icon(Icons.Default.Add, "新建任务") }
        }
        LazyRow(contentPadding = PaddingValues(16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            item { FilterChip(s.selectedProjectId == null, { vm.selectProject(null) }, label = { Text("全部项目") }) }
            items(s.projects, key = { it.id }) { p ->
                FilterChip(s.selectedProjectId == p.id, { vm.selectProject(p.id) }, label = { Text(p.name) })
            }
        }
        if (!s.supportsSafeSend) Info("电脑端需要更新至 0.2.0，才能启用可靠发送。")
        s.pending?.let { PendingBanner(s, vm) }
        s.error?.let { ErrorMessage(it) }
        if (s.threads.isEmpty()) EmptyState("还没有可显示的对话", "检查连接或切换项目，然后点击刷新。", Modifier.weight(1f))
        else LazyColumn(Modifier.weight(1f), contentPadding = PaddingValues(bottom = 16.dp)) {
            items(s.threads.sortedByDescending { it.isPinned }, key = { it.id }) { thread ->
                Column(Modifier.fillMaxWidth().clickable { vm.openThread(thread.id) }.padding(start = 20.dp, end = 12.dp, top = 12.dp, bottom = 8.dp)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Text(thread.name?.takeIf(String::isNotBlank) ?: "未命名对话", Modifier.weight(1f),
                            color = Ink, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        IconButton({ vm.favorite(thread) }, Modifier.size(44.dp)) {
                            Icon(if (thread.isPinned) Icons.Default.Star else Icons.Default.StarBorder, "切换收藏",
                                tint = if (thread.isPinned) Blue else Muted, modifier = Modifier.size(20.dp))
                        }
                    }
                    Text(thread.preview?.takeIf(String::isNotBlank) ?: "打开继续任务", color = Muted, maxLines = 2,
                        overflow = TextOverflow.Ellipsis, fontSize = 14.sp, lineHeight = 21.sp)
                    Row(Modifier.padding(top = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(thread.model ?: "Codex", color = Muted, fontSize = 11.sp, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                        if (thread.activeTurnId != null) Text("运行中", color = Color(0xFF176B62), fontSize = 12.sp)
                    }
                    HorizontalDivider(Modifier.padding(top = 14.dp), color = Line)
                }
            }
            if (s.nextCursor != null) item { TextButton(vm::loadMoreThreads, Modifier.fillMaxWidth(), enabled = !s.busy) { Text("加载更多对话") } }
        }
    }
}

@Composable private fun SettingsScreen(s: PhoneUiState, vm: PhoneViewModel, forget: () -> Unit, modifier: Modifier) {
    var confirmRevoke by remember { mutableStateOf(false) }
    Column(modifier.fillMaxSize().statusBarsPadding().verticalScroll(rememberScrollState()).padding(20.dp)) {
        Text("连接与设置", color = Ink, fontSize = 25.sp, fontWeight = FontWeight.Bold)
        Spacer(Modifier.height(24.dp))
        Text("当前电脑", color = Muted, fontSize = 12.sp)
        Text(s.hostUrl, Modifier.padding(top = 6.dp), color = Ink)
        Text(if (s.realtime) "实时连接已建立" else "实时连接暂不可用，返回前台会自动重试",
            Modifier.padding(top = 10.dp), color = if (s.realtime) Color(0xFF176B62) else Muted, fontSize = 13.sp)
        HorizontalDivider(Modifier.padding(vertical = 20.dp), color = Line)
        Text("Host " + (s.hostVersion ?: "旧版本") + "\nCodex " + (s.hostStatus?.codexVersion ?: "未知") +
            "\n模型服务 " + (s.hostStatus?.provider ?: "未知"), color = Muted, lineHeight = 24.sp)
        TextButton(vm::refresh, Modifier.padding(top = 12.dp), enabled = !s.busy) { Text("检查连接") }
        HorizontalDivider(Modifier.padding(vertical = 20.dp), color = Line)
        Text("手机离线或退到后台时，电脑任务仍会继续。重新打开应用后自动补齐状态；本版不承诺锁屏实时通知。", color = Muted, fontSize = 14.sp, lineHeight = 22.sp)
        Spacer(Modifier.height(24.dp))
        OutlinedButton({ confirmRevoke = true }, Modifier.fillMaxWidth(), enabled = !s.sending) { Text("撤销配对并清除手机数据") }
        TextButton(forget, Modifier.fillMaxWidth(), enabled = !s.sending) { Text("电脑无法连接？仅清除本机连接") }
        s.error?.let { ErrorMessage(it) }
        Text("CodexPhone " + BuildConfig.VERSION_NAME + " · MIT 开源", Modifier.padding(top = 20.dp), color = Muted, fontSize = 12.sp)
    }
    if (confirmRevoke) AlertDialog(onDismissRequest = { confirmRevoke = false }, title = { Text("解除设备配对？") },
        text = { Text("会撤销电脑端授权，并清除本机缓存和草稿。未确认的提交仍可能在电脑上执行，请先检查任务。") },
        confirmButton = { TextButton({ confirmRevoke = false; vm.disconnect() }) { Text("撤销并清除") } },
        dismissButton = { TextButton({ confirmRevoke = false }) { Text("取消") } })
}
@Composable private fun ApprovalInbox(s: PhoneUiState, vm: PhoneViewModel, modifier: Modifier) {
    Column(modifier.fillMaxSize()) {
        Header("待处理", "审批和问题由你决定", s, vm)
        if (s.approvals.isEmpty()) EmptyState("暂时没有待处理请求", "需要审批或回答时会显示在这里。", Modifier.weight(1f))
        else LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            items(s.approvals, key = { it.id }) { approval ->
                ApprovalCard(approval, s.busy, vm)
                TextButton({ vm.openThread(approval.threadId) }) { Text("打开所属对话") }
            }
        }
        s.error?.let { ErrorMessage(it) }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable private fun ConversationScreen(s: PhoneUiState, vm: PhoneViewModel) {
    var modelSheet by remember { mutableStateOf(false) }
    var confirmStop by remember { mutableStateOf(false) }
    var navigation by remember { mutableStateOf(false) }
    var reviewedQueue by remember { mutableStateOf<QueuedMessage?>(null) }
    var initiallyPositioned by remember(s.selectedThreadId) { mutableStateOf(false) }
    var followLatest by remember(s.selectedThreadId) { mutableStateOf(true) }
    var positioning by remember { mutableStateOf(false) }
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()
    val atBottom by remember { derivedStateOf {
        listState.layoutInfo.totalItemsCount == 0 || (listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0) >= listState.layoutInfo.totalItemsCount - 2
    } }
    val messages = s.selectedThread?.turns.orEmpty().flatMap { turn -> turn.items.map { (turn.id + ":" + it.id) to it } }
    val items = messages.map { it.second }
    val title = if (s.composingNew) "新建任务" else s.selectedThread?.thread?.name?.takeIf(String::isNotBlank) ?: "对话"
    val running = s.selectedThread?.thread?.activeTurnId != null
    LaunchedEffect(listState, s.selectedThreadId) {
        snapshotFlow { listState.isScrollInProgress to atBottom }.collect { (scrolling, bottom) ->
            if (scrolling && !positioning) followLatest = bottom
        }
    }
    LaunchedEffect(s.selectedThreadId, items.lastOrNull()?.text?.length, items.size) {
        if ((!initiallyPositioned || followLatest) && items.isNotEmpty()) {
            val expectedCount = messages.size + 1 + (if (s.selectedThread?.nextCursor != null) 1 else 0) +
                s.approvals.count { it.threadId == s.selectedThreadId }
            // Wait for the new snapshot's layout, rather than scrolling the old
            // loading placeholder and considering the conversation positioned.
            snapshotFlow { listState.layoutInfo.totalItemsCount }.first { it >= expectedCount }
            positioning = true
            try { listState.scrollToItem(expectedCount - 1) } finally { positioning = false }
            initiallyPositioned = true
        }
    }
    Scaffold(containerColor = Background, contentWindowInsets = WindowInsets(0, 0, 0, 0),
        topBar = {
            Surface(color = Color.White) {
                Row(Modifier.fillMaxWidth().statusBarsPadding().padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    IconButton(vm::closeThread) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "返回") }
                    Column(Modifier.weight(1f)) {
                        Text(title, color = Ink, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text(if (s.realtime) "与电脑实时同步" else "正在恢复连接", color = Muted, fontSize = 11.sp)
                    }
                    if (running) IconButton({ confirmStop = true }, enabled = !s.busy) { Icon(Icons.Default.StopCircle, "中断任务", tint = Color(0xFFB3433B)) }
                    IconButton({ navigation = true }) { Icon(Icons.Default.SwapVert, "对话导航") }
                    IconButton(vm::refresh, enabled = !s.busy) { Icon(Icons.Default.Refresh, "刷新对话") }
                }
            }
        },
        bottomBar = {
            Surface(color = Color.White, shadowElevation = 3.dp) {
                Column(Modifier.navigationBarsPadding().imePadding().padding(horizontal = 12.dp, vertical = 8.dp)) {
                    if (s.queued.any { it.threadId == s.selectedThreadId }) Column(Modifier.heightIn(max = 160.dp).verticalScroll(rememberScrollState())) {
                        s.queued.filter { it.threadId == s.selectedThreadId }.forEach { message ->
                            Surface(color = Color(0xFFE8EEFC), shape = RoundedCornerShape(12.dp), modifier = Modifier.padding(bottom = 6.dp)) {
                                Row(Modifier.fillMaxWidth().padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
                                    Column(Modifier.weight(1f)) {
                                        Text(if (message.state == "queued") "排队中 · 本轮结束后发送" else if (message.state == "dispatching") "正在提交" else "结果待确认 · 请检查对话", fontSize = 11.sp, color = Muted)
                                        Text(message.prompt, maxLines = 2, overflow = TextOverflow.Ellipsis, fontSize = 13.sp, color = Ink)
                                    }
                                    TextButton({ vm.guideQueued(message) }, enabled = running && message.state == "queued" && !s.sending && s.pending == null) { Text("引导") }
                                    IconButton({ if (message.state == "unknown") reviewedQueue = message else vm.cancelQueued(message) }, enabled = message.state != "dispatching" && !s.busy) { Icon(Icons.Default.Close, "移除排队消息", Modifier.size(18.dp)) }
                                }
                            }
                        }
                    }
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        TextButton({ modelSheet = true }, contentPadding = PaddingValues(horizontal = 6.dp)) {
                            Text((s.model ?: "默认模型").substringAfterLast('/'), maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Icon(Icons.Default.ExpandMore, null, Modifier.size(18.dp))
                        }
                        Text(s.effort ?: "", fontSize = 12.sp, color = Muted)
                        Spacer(Modifier.weight(1f))
                        if (running) Text("运行中 · 发送后排队", color = Color(0xFF176B62), fontSize = 12.sp)
                    }
                    Row(verticalAlignment = Alignment.Bottom) {
                        OutlinedTextField(s.draft, vm::editDraft, Modifier.weight(1f).heightIn(min = 50.dp, max = 180.dp),
                            placeholder = { Text(if (running) "发送后排队，可点击引导干预…" else "输入消息，回车换行…") },
                            maxLines = 6, shape = RoundedCornerShape(16.dp),
                            keyboardOptions = KeyboardOptions(imeAction = ImeAction.Default, capitalization = KeyboardCapitalization.Sentences))
                        Spacer(Modifier.width(8.dp))
                        FilledIconButton({ vm.send() }, Modifier.size(48.dp),
                            enabled = s.draft.isNotBlank() && s.pending == null && !s.sending && s.supportsSafeSend && s.hostStatus?.status == "ready") {
                            if (s.sending) CircularProgressIndicator(Modifier.size(21.dp), color = Color.White, strokeWidth = 2.dp)
                            else Icon(Icons.AutoMirrored.Filled.Send, if (running) "排队发送" else "发送消息")
                        }
                    }
                }
            }
        }) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            if (!s.supportsSafeSend) Info("请更新电脑端至 0.2.0 后发送。当前可以浏览历史。")
            if (s.composingNew) {
                Text("选择允许启动任务的项目", Modifier.padding(start = 16.dp, top = 12.dp), color = Muted, fontSize = 13.sp)
                LazyRow(contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(s.projects.filter(Project::canStart), key = { it.id }) { p ->
                        FilterChip(s.selectedProjectId == p.id, { vm.selectProject(p.id) }, label = { Text(p.name) })
                    }
                }
                if (s.projects.none(Project::canStart)) Info("请先在电脑或网页端登记可启动的项目。")
            }
            if (s.pending != null) PendingBanner(s, vm)
            s.error?.let { ErrorMessage(it) }
            Box(Modifier.weight(1f).fillMaxWidth()) {
                LazyColumn(Modifier.fillMaxSize(), state = listState, contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    if (s.selectedThread?.nextCursor != null) item { TextButton(vm::loadEarlier, Modifier.fillMaxWidth(), enabled = !s.busy) { Text("加载更早消息") } }
                    if (s.composingNew) item { EmptyState("准备开始一个任务", "描述你希望电脑上的 Codex 完成什么。", Modifier.padding(top = 36.dp)) }
                    if (s.selectedThreadId != null && s.selectedThread == null) item {
                        Box(Modifier.fillMaxWidth().padding(30.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                    }
                    items(messages, key = { it.first }) { (_, item) -> MessageBubble(item, s.selectedThreadId.orEmpty(), vm.imageApi()) }
                    items(s.approvals.filter { it.threadId == s.selectedThreadId }, key = { "approval-" + it.id }) { ApprovalCard(it, s.busy, vm) }
                    item { Spacer(Modifier.height(2.dp)) }
                }
                if (!atBottom && items.isNotEmpty()) SmallFloatingActionButton(
                    { scope.launch { listState.animateScrollToItem((listState.layoutInfo.totalItemsCount - 1).coerceAtLeast(0)); followLatest = true } },
                    Modifier.align(Alignment.BottomEnd).padding(12.dp), containerColor = Color.White,
                ) { Icon(Icons.Default.KeyboardArrowDown, "回到最新消息") }
            }
        }
    }
    if (navigation) ModalBottomSheet(onDismissRequest = { navigation = false }) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 20.dp).padding(bottom = 24.dp)) {
            Text("对话导航", fontSize = 20.sp, fontWeight = FontWeight.Bold)
            TextButton({ navigation = false; scope.launch { listState.scrollToItem((listState.layoutInfo.totalItemsCount - 1).coerceAtLeast(0)); followLatest = true } }) { Text("跳到最新消息") }
            if (s.selectedThread?.nextCursor != null) TextButton({ vm.loadEarlier() }, enabled = !s.busy) { Text("加载更早消息") }
            LazyColumn(Modifier.heightIn(max = 420.dp)) {
                itemsIndexed(s.selectedThread?.turns.orEmpty(), key = { _, turn -> turn.id }) { index, turn ->
                    Column(Modifier.fillMaxWidth().clickable {
                        navigation = false
                        followLatest = false
                        val position = messages.indexOfFirst { it.first.startsWith(turn.id + ":") }
                        if (position >= 0) scope.launch { listState.scrollToItem(position + if (s.selectedThread?.nextCursor != null) 1 else 0) }
                    }.padding(vertical = 12.dp)) {
                        Text("第 ${index + 1} 轮", fontWeight = FontWeight.SemiBold, color = Ink)
                        Text(turn.items.firstOrNull { it.type == "userMessage" }?.text ?: turn.items.firstOrNull()?.text ?: "任务消息", maxLines = 2, overflow = TextOverflow.Ellipsis, color = Muted, fontSize = 13.sp)
                    }
                }
            }
        }
    }
    reviewedQueue?.let { message -> AlertDialog(onDismissRequest = { reviewedQueue = null }, title = { Text("已检查电脑端对话？") }, text = { Text("移除记录不会取消可能已经执行的消息。确认结果后再继续排队。") }, confirmButton = { TextButton({ reviewedQueue = null; vm.cancelQueued(message) }) { Text("已检查，移除记录") } }, dismissButton = { TextButton({ reviewedQueue = null }) { Text("取消") } }) }
    if (modelSheet) ModalBottomSheet(onDismissRequest = { modelSheet = false }) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = 20.dp).padding(bottom = 32.dp)) {
            Text("模型与推理强度", fontSize = 20.sp, fontWeight = FontWeight.Bold)
            s.models.forEach { model ->
                Row(Modifier.fillMaxWidth().clickable { vm.chooseModel(model.id) }.padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                    RadioButton(s.model == model.id, { vm.chooseModel(model.id) })
                    Column { Text(model.name); Text(model.id, color = Muted, fontSize = 11.sp) }
                }
            }
            HorizontalDivider(Modifier.padding(vertical = 12.dp))
            Text("推理强度", fontWeight = FontWeight.SemiBold)
            s.models.find { it.id == s.model }?.efforts.orEmpty().forEach { effort ->
                Row(Modifier.fillMaxWidth().clickable { vm.chooseEffort(effort) }, verticalAlignment = Alignment.CenterVertically) {
                    RadioButton(s.effort == effort, { vm.chooseEffort(effort) }); Text(effort)
                }
            }
            Button({ modelSheet = false }, Modifier.fillMaxWidth().padding(top = 12.dp)) { Text("完成") }
        }
    }
    if (confirmStop) AlertDialog(onDismissRequest = { confirmStop = false }, title = { Text("中断当前任务？") },
        text = { Text("已完成的修改会保留。之后可以继续发送消息。") },
        confirmButton = { TextButton({ confirmStop = false; vm.interrupt() }) { Text("中断") } },
        dismissButton = { TextButton({ confirmStop = false }) { Text("继续运行") } })
}

@Composable private fun PendingBanner(s: PhoneUiState, vm: PhoneViewModel) {
    var confirm by remember { mutableStateOf(false) }
    Surface(color = Color(0xFFFFF3DA)) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 14.dp, vertical = 8.dp)) {
            Text(if (s.pendingStatus == "failed") "电脑未完成本次提交，请先检查对话。" else "有一条消息等待电脑确认。草稿已保留。", fontSize = 12.sp, color = Color(0xFF785519))
            Row {
                TextButton(vm::checkPending, enabled = !s.busy && !s.sending) { Text("查询结果", fontSize = 12.sp) }
                if (s.pendingStatus == "not-found") TextButton(vm::retryPending, enabled = !s.sending) { Text("原编号重试", fontSize = 12.sp) }
                if (s.pendingStatus in listOf("failed", "unknown")) TextButton({ confirm = true }, enabled = !s.sending) { Text("已检查对话", fontSize = 12.sp) }
            }
        }
    }
    if (confirm) AlertDialog(onDismissRequest = { confirm = false }, title = { Text("解除待确认状态？") },
        text = { Text("请确认已检查电脑端对话。解除不会取消可能正在执行的任务，之后重新发送可能重复执行。") },
        confirmButton = { TextButton({ confirm = false; vm.dismissPendingAfterReview() }) { Text("确认已检查") } },
        dismissButton = { TextButton({ confirm = false }) { Text("继续查询") } })
}

@Composable private fun ApprovalCard(a: ApprovalRequest, busy: Boolean, vm: PhoneViewModel) {
    var answers by remember(a.id) { mutableStateOf(a.questions.associate { it.id to "" }) }
    Surface(color = Color.White, shape = RoundedCornerShape(14.dp), border = BorderStroke(1.dp, Color(0xFFE0C897))) {
        Column(Modifier.fillMaxWidth().padding(16.dp)) {
            Text(a.title, fontWeight = FontWeight.Bold, color = Ink)
            if (a.detail.isNotBlank()) SelectionContainerCompat(a.detail)
            if (a.kind == "question") {
                a.questions.forEach { q ->
                    Text(q.question, Modifier.padding(top = 14.dp), color = Ink, fontWeight = FontWeight.Medium)
                    q.options.forEach { option ->
                        Row(Modifier.fillMaxWidth().clickable { answers = answers + (q.id to option.label) }, verticalAlignment = Alignment.CenterVertically) {
                            RadioButton(answers[q.id] == option.label, { answers = answers + (q.id to option.label) })
                            Column(Modifier.weight(1f)) { Text(option.label); if (option.description.isNotBlank()) Text(option.description, color = Muted, fontSize = 12.sp) }
                        }
                    }
                    OutlinedTextField(answers[q.id].orEmpty(), { answers = answers + (q.id to it) },
                        Modifier.fillMaxWidth().padding(top = 6.dp), label = { Text("你的回答") },
                        visualTransformation = if (q.secret) PasswordVisualTransformation() else VisualTransformation.None)
                }
                Button({ vm.answer(a, answers = answers) }, Modifier.padding(top = 14.dp),
                    enabled = !busy && a.questions.all { answers[it.id].orEmpty().isNotBlank() }) { Text("提交回答") }
            } else Row(Modifier.padding(top = 12.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedButton({ vm.answer(a, "decline") }, enabled = !busy) { Text("拒绝") }
                Button({ vm.answer(a, "accept") }, enabled = !busy && a.canAccept) { Text("允许本次") }
            }
        }
    }
}
@Composable private fun SelectionContainerCompat(text: String) {
    androidx.compose.foundation.text.selection.SelectionContainer {
        Text(text, Modifier.padding(top = 10.dp).heightIn(max = 220.dp).verticalScroll(rememberScrollState()),
            color = Muted, fontSize = 13.sp, lineHeight = 20.sp)
    }
}
@Composable private fun MessageBubble(item: ThreadItem, threadId: String, api: CodexPhoneApi?) {
    val user = item.type == "userMessage"
    val clipboard = LocalClipboardManager.current
    Row(Modifier.fillMaxWidth(), horizontalArrangement = if (user) Arrangement.End else Arrangement.Start) {
        Column(if (user) Modifier.widthIn(max = 330.dp) else Modifier.fillMaxWidth()) {
            Text(if (user) "你" else "Codex", Modifier.padding(start = 4.dp, bottom = 6.dp), color = Muted, fontSize = 11.sp)
            Surface(color = if (user) Color(0xFFE4ECFF) else Color.White, shape = RoundedCornerShape(14.dp)) {
                Column(Modifier.padding(14.dp)) {
                    MarkdownMessage(item.text, item.images, threadId, api)
                    if (item.text.isNotBlank()) Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                        IconButton({ clipboard.setText(AnnotatedString(item.text)) }, Modifier.size(36.dp)) {
                            Icon(Icons.Default.ContentCopy, "复制消息", Modifier.size(16.dp), tint = Muted)
                        }
                    }
                }
            }
        }
    }
}
@Composable fun MediaPreview(url: String, api: CodexPhoneApi, modifier: Modifier = Modifier) {
    val context = LocalContext.current
    val loader = remember(api) { ImageLoader.Builder(context).okHttpClient(api.imageClient()).diskCache(null).components { add(SvgDecoder.Factory()) }.build() }
    var expanded by remember(url) { mutableStateOf(false) }
    val authorized = api.authorizedImageRequest(url)
    val request = remember(url, api) {
        ImageRequest.Builder(context).data(url).apply {
            authorized?.headers?.forEach { (name, value) -> addHeader(name, value) }
        }.crossfade(false).build()
    }
    SubcomposeAsyncImage(request, null, imageLoader = loader, modifier = modifier.fillMaxWidth().heightIn(min = 70.dp, max = 340.dp).clickable { expanded = true },
        loading = { Box(Modifier.padding(20.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(24.dp)) } },
        error = { Text("图片暂不可用，请检查电脑端文件路径或刷新。", color = Muted, fontSize = 12.sp) })
    if (expanded) Dialog({ expanded = false }, properties = DialogProperties(usePlatformDefaultWidth = false)) {
        var scale by remember { mutableFloatStateOf(1f) }
        Box(Modifier.fillMaxSize().background(Color(0xF0182235)).pointerInput(Unit) {
            detectTransformGestures { _, _, zoom, _ -> scale = (scale * zoom).coerceIn(1f, 5f) }
        }) {
            SubcomposeAsyncImage(request, null, imageLoader = loader,
                modifier = Modifier.fillMaxSize().graphicsLayer(scaleX = scale, scaleY = scale))
            IconButton({ expanded = false }, Modifier.align(Alignment.TopEnd).statusBarsPadding().padding(12.dp)) { Icon(Icons.Default.Close, "关闭图片", tint = Color.White) }
        }
    }
}
@Composable private fun EmptyState(title: String, detail: String, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth().padding(24.dp), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        Text(title, color = Ink, fontWeight = FontWeight.SemiBold)
        Text(detail, Modifier.padding(top = 8.dp), color = Muted, fontSize = 13.sp, lineHeight = 20.sp)
    }
}
@Composable private fun ErrorMessage(message: String) {
    Text(message, Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), color = Color(0xFFA33F38), fontSize = 12.sp, lineHeight = 18.sp)
}
@Composable private fun Info(message: String) {
    Text(message, Modifier.fillMaxWidth().background(Color(0xFFE8EEFC)).padding(12.dp), color = Muted, fontSize = 12.sp, lineHeight = 18.sp)
}
