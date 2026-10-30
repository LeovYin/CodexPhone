package app.codexphone.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

@Serializable data class PairResponse(val token: String, val deviceId: String)
@Serializable data class AccountHost(val id: String, val name: String, val url: String)
@Serializable data class AccountUser(val id: String, val username: String)
@Serializable data class AccountLogin(val token: String, val expiresAt: Long, val account: AccountUser, val host: AccountHost? = null)
data class RememberedAccountServer(val url: String, val username: String, val computerUrl: String = "")
@Serializable data class HostStatus(
    val status: String = "starting", val codexVersion: String = "unknown",
    val model: String = "unknown", val provider: String = "unknown", val transport: String? = null,
    val lastError: String? = null, val activeTasks: Int = 0, val pairedDevices: Int = 0,
)
@Serializable data class Capabilities(val hostVersion: String, val protocolVersion: Int, val capabilities: List<String> = emptyList())
@Serializable data class Project(val id: String, val name: String, val path: String? = null, val canStart: Boolean = false)
@Serializable data class ProjectsResponse(val projects: List<Project> = emptyList())
@Serializable data class ThreadsResponse(val threads: List<ThreadSummary> = emptyList(), val nextCursor: String? = null)
@Serializable data class ThreadSummary(
    val id: String, val name: String? = null, val preview: String? = null, val cwd: String? = null,
    val model: String? = null, val provider: String? = null, val updatedAt: String? = null,
    val status: JsonElement? = null, val turns: Int = 0, val isPinned: Boolean = false,
    val canControl: Boolean = false, val activeTurnId: String? = null, val writeState: String = "unknown",
)
@Serializable data class ThreadDetail(
    val thread: ThreadSummary, val turns: List<ThreadTurn> = emptyList(), val nextCursor: String? = null,
    val approvals: List<ApprovalRequest> = emptyList(), val model: String? = null, val effort: String? = null,
)
@Serializable data class ThreadTurn(val id: String, val status: String? = null, val items: List<ThreadItem> = emptyList(), val startedAt: Long? = null)
@Serializable data class ThreadItem(val id: String, val type: String, val text: String = "", val images: List<String> = emptyList(), val status: String? = null)
@Serializable data class ModelOption(val id: String, val name: String, val efforts: List<String> = emptyList(), val defaultEffort: String = "")
@Serializable data class ModelsResponse(val models: List<ModelOption> = emptyList(), val defaultModel: String = "")
@Serializable data class ApprovalQuestion(val id: String, val question: String, val options: List<QuestionOption> = emptyList(), val secret: Boolean = false)
@Serializable data class QuestionOption(val label: String, val description: String = "")
@Serializable data class ApprovalRequest(
    val id: String, val threadId: String, val turnId: String, val kind: String,
    val title: String, val detail: String = "", val canAccept: Boolean = false, val questions: List<ApprovalQuestion> = emptyList(),
)
@Serializable data class ApprovalsResponse(val approvals: List<ApprovalRequest> = emptyList())
@Serializable data class ApiError(val error: String? = null)
@Serializable data class QueuedMessage(val id: String, val threadId: String, val prompt: String, val state: String, val error: String? = null)
@Serializable data class QueueResponse(val messages: List<QueuedMessage> = emptyList())
@Serializable data class PendingSubmission(
    val requestId: String, val threadId: String?, val projectId: String?,
    val prompt: String, val model: String?, val effort: String?, val kind: String = "send",
    val createdAt: Long = System.currentTimeMillis(),
)
@Serializable data class LocalData(
    val drafts: Map<String, String> = emptyMap(), val pending: PendingSubmission? = null,
    val threads: List<ThreadSummary> = emptyList(), val details: List<ThreadDetail> = emptyList(),
)
