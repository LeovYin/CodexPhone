package app.codexphone.data

/** Treat network snapshots and old cache files as untrusted display data. */
object LocalDataPolicy {
    fun threads(values: List<ThreadSummary>) = values.filter { it.id.isNotBlank() }.distinctBy { it.id }
        .map { it.copy(name = it.name?.take(160), preview = it.preview?.take(800)) }
    fun detail(value: ThreadDetail): ThreadDetail = value.copy(turns = value.turns.filter { it.id.isNotBlank() }.distinctBy { it.id }
        .map { turn -> turn.copy(items = turn.items.filter { it.id.isNotBlank() }.distinctBy { it.id }) })
    fun bounded(value: LocalData, includeCache: Boolean = true): LocalData {
        var draftBudget = 64_000
        val drafts = value.drafts.entries.toList().takeLast(20).asReversed().associate { (key, text) ->
            val kept = text.take(minOf(20_000, draftBudget)); draftBudget -= kept.length; key to kept
        }.filterValues { it.isNotEmpty() }
        var textBudget = 80_000
        val details = if (!includeCache) emptyList() else value.details.take(3).map { cached ->
            detail(cached).let { safe -> safe.copy(turns = safe.turns.takeLast(20).map { turn ->
                turn.copy(items = turn.items.takeLast(80).map { item ->
                    val text = item.text.take(minOf(16_000, textBudget)); textBudget -= text.length
                    item.copy(text = text, images = item.images.take(8))
                })
            }) }
        }
        return value.copy(drafts = drafts, threads = if (includeCache) threads(value.threads).take(60) else emptyList(), details = details)
    }
}
