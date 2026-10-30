package app.codexphone

import android.app.Application
import android.util.AtomicFile
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.codexphone.data.*
import org.junit.*
import org.junit.runner.RunWith
import java.io.File

@RunWith(AndroidJUnit4::class)
class CredentialRecoveryTest {
    private val app get() = ApplicationProvider.getApplicationContext<Application>()
    @Before @After fun clean() {
        app.getSharedPreferences("device-connection", 0).edit().clear().commit()
        listOf("conversation-cache.enc", "submission-journal.enc", "legacy-state-quarantined.enc").forEach { AtomicFile(File(app.filesDir, it)).delete() }
    }
    @Test fun corruptDisplayCachePreservesLoginDraftAndUncertainSubmission() {
        val credentials = DeviceCredentialStore(app)
        credentials.saveSession("http://127.0.0.1:4318", "fixture-token", "device")
        val store = ConversationStore(credentials)
        store.draft("thread", "不要丢失草稿")
        store.pending(PendingSubmission("fixture-persisted-request-0001", "thread", null, "只提交一次", "model", "high"))
        File(app.filesDir, "conversation-cache.enc").writeText("corrupt encrypted cache")
        val restoredCredentials = DeviceCredentialStore(app)
        val restored = ConversationStore(restoredCredentials)
        Assert.assertEquals("fixture-token", restoredCredentials.token())
        Assert.assertEquals("不要丢失草稿", restored.draft("thread"))
        Assert.assertEquals("fixture-persisted-request-0001", restored.data.pending?.requestId)
        Assert.assertTrue(restoredCredentials.recoveredData)
        restored.clearDisplayCache()
        Assert.assertEquals("fixture-persisted-request-0001", ConversationStore(DeviceCredentialStore(app)).data.pending?.requestId)
    }
}
