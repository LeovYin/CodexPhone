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
        File(app.filesDir, "connections").deleteRecursively()
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
    @Test fun successfulServersRemainSelectableAfterLogoutClearsSession() {
        val credentials = DeviceCredentialStore(app)
        credentials.saveSession("http://computer-one:4318", "device-token", "device-one")
        credentials.saveAccount("http://100.64.0.1:4321", "alice", "account-token-one")
        credentials.saveAccount("http://100.64.0.2:4321", "bob", "account-token-two")
        Assert.assertEquals("bob", credentials.username)
        Assert.assertEquals(2, credentials.rememberedServers().size)
        credentials.selectAccountServer(credentials.rememberedServers().last())
        Assert.assertEquals("alice", credentials.username)
        Assert.assertNull(credentials.accountToken())
        credentials.saveAccount("http://100.64.0.1:4321", "alice", "account-token-one")
        credentials.clearToken()
        Assert.assertNull(credentials.token())
        Assert.assertNull(credentials.accountToken())
        Assert.assertEquals("alice", credentials.username)
        Assert.assertEquals(2, credentials.rememberedServers().size)
        credentials.removeRememberedServer("http://100.64.0.1:4321", "alice")
        Assert.assertEquals("bob", credentials.username)
        Assert.assertEquals(1, credentials.rememberedServers().size)
    }
    @Test fun disconnectPersistsAcrossRestartAndProfilesIsolateDraftsAndUncertainSubmissions() {
        val credentials = DeviceCredentialStore(app)
        credentials.activateConversationProfile("account-a", "computer-a", false)
        credentials.saveSession("http://192.168.1.20:4318", "fixture-device-token", "device")
        credentials.saveAccount("http://192.168.1.20:4321", "alice", "fixture-account-token", "http://192.168.1.20:4318")
        val original = ConversationStore(credentials)
        original.draft("shared", "切换网络前的草稿")
        original.pending(PendingSubmission("fixture-uncertain-request-0001", "shared", null, "已经发送，请先查询", null, null))
        credentials.pauseConnection()
        val restarted = DeviceCredentialStore(app)
        Assert.assertTrue(restarted.connectionPaused)
        Assert.assertEquals("fixture-device-token", restarted.token())
        Assert.assertEquals("fixture-account-token", restarted.accountToken())
        Assert.assertEquals("http://192.168.1.20:4318", restarted.rememberedServers().single().computerUrl)
        val switched = ConversationStore(restarted)
        switched.activateProfile("account-b", "computer-b", false)
        Assert.assertEquals("", switched.draft("shared"))
        Assert.assertNull(switched.data.pending)
        switched.draft("shared", "另一台电脑的草稿"); switched.persist()
        switched.activateProfile("account-a", "computer-a", false)
        Assert.assertEquals("切换网络前的草稿", switched.draft("shared"))
        Assert.assertEquals("fixture-uncertain-request-0001", switched.data.pending?.requestId)
        credentials.saveSession("http://100.64.0.1:4318", "renewed-device-token", "device")
        Assert.assertFalse(credentials.connectionPaused)
    }
    @Test fun legacyJournalMigratesWithoutLosingAnUncertainSubmission() {
        val credentials = DeviceCredentialStore(app)
        val legacy = ConversationStore(credentials)
        legacy.draft("shared", "升级前的草稿")
        legacy.pending(PendingSubmission("fixture-legacy-request-0001", "shared", null, "待确认内容", null, null))
        legacy.activateProfile("account-a", "computer-a", true)
        val restored = ConversationStore(DeviceCredentialStore(app))
        Assert.assertEquals("升级前的草稿", restored.draft("shared"))
        Assert.assertEquals("fixture-legacy-request-0001", restored.data.pending?.requestId)
    }
}
