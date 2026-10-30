package app.codexphone.data

import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

class ConversationStore(private val credentials: DeviceCredentialStore) {
    private val json = Json { ignoreUnknownKeys = true }
    var data: LocalData = runCatching { credentials.readLocal()?.let { json.decodeFromString<LocalData>(it) } }.getOrNull() ?: LocalData()
        private set
    @Synchronized fun draft(key: String): String = data.drafts[key].orEmpty()
    @Synchronized fun draft(key: String, text: String) {
        val drafts = data.drafts.toMutableMap()
        if (text.isEmpty()) drafts.remove(key) else drafts[key] = text.take(20_000)
        data = data.copy(drafts = drafts.entries.toList().takeLast(50).associate { it.key to it.value })
    }
    @Synchronized fun pending(value: PendingSubmission?) { data = data.copy(pending = value); persist() }
    @Synchronized fun cache(threads: List<ThreadSummary>, detail: ThreadDetail?) {
        val details = if (detail == null) data.details else
            (listOf(detail.copy(turns = detail.turns.takeLast(80).map { turn -> turn.copy(items = turn.items.map { it.copy(text = it.text.take(30_000)) }) })) +
                data.details.filter { it.thread.id != detail.thread.id }).take(3)
        data = data.copy(threads = threads.take(60), details = details)
    }
    @Synchronized fun persist() = credentials.saveLocal(json.encodeToString(data))
    @Synchronized fun clear() { data = LocalData(); credentials.clearToken() }
}
