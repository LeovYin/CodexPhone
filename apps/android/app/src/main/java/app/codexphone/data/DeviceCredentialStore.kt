package app.codexphone.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import android.util.AtomicFile
import java.io.File
import app.codexphone.CodexPhoneApplication

class DeviceCredentialStore(context: Context) {
    private val directory = context.filesDir
    val skipDisplayCache = (context.applicationContext as? CodexPhoneApplication)?.recoveredAfterCrash == true
    var recoveredData = skipDisplayCache
        private set
    private val preferences = context.getSharedPreferences("device-connection", Context.MODE_PRIVATE)
    private fun string(key: String): String? = runCatching { preferences.getString(key, null) }.getOrNull()

    var hostUrl: String?
        get() = string(KEY_HOST)
        set(value) { preferences.edit().putString(KEY_HOST, value).apply() }

    val deviceId: String? get() = string("device-id")
    val accountsUrl: String? get() = string("accounts-url")
    val username: String? get() = string("account-username")
    val activeUsername: String? get() = string("active-account-username") ?: username
    val computerUrl: String get() = string("computer-url").orEmpty()
    val connectionPaused: Boolean get() = preferences.getBoolean("connection-paused", false)
    private val conversationScope: String? get() = string("conversation-scope")
    fun rememberedServers(): List<RememberedAccountServer> = runCatching {
        val saved = org.json.JSONArray(string("remembered-account-servers") ?: "[]")
        (0 until saved.length()).mapNotNull { index ->
            val item = saved.optJSONObject(index) ?: return@mapNotNull null
            val url = item.optString("url").takeIf(String::isNotBlank) ?: return@mapNotNull null
            val name = item.optString("username").takeIf(String::isNotBlank) ?: return@mapNotNull null
            RememberedAccountServer(url, name, item.optString("computerUrl"))
        }
    }.getOrDefault(emptyList())
    val installationId: String get() = string("installation-id") ?: java.util.UUID.randomUUID().toString().also { preferences.edit().putString("installation-id", it).commit() }
    fun accountToken(): String? = string("account-token")?.let { runCatching { decrypt(it) }.getOrNull() }
    fun saveAccount(url: String, username: String, token: String, computerUrl: String = "") {
        val server = RememberedAccountServer(url.trimEnd('/'), username.trim(), computerUrl.trimEnd('/'))
        val updated = (listOf(server) + rememberedServers().filterNot { it.url.equals(server.url, true) && it.username.equals(server.username, true) }).take(10)
        val packed = packServers(updated)
        check(preferences.edit().putString("accounts-url", server.url).putString("account-username", server.username)
            .putString("active-account-username", server.username)
            .putString("computer-url", server.computerUrl).putString("remembered-account-servers", packed).putString("account-token", encrypt(token)).commit())
    }
    fun selectAccountServer(server: RememberedAccountServer) {
        val editor = preferences.edit().putString("accounts-url", server.url).putString("account-username", server.username).putString("computer-url", server.computerUrl)
        if (string("active-account-username") == null && token() != null) editor.putString("active-account-username", username)
        if (!accountsUrl.equals(server.url, true) || !username.equals(server.username, true)) editor.remove("account-token")
        check(editor.commit())
    }
    fun removeRememberedServer(url: String, username: String) {
        val updated = rememberedServers().filterNot { it.url.equals(url, true) && it.username.equals(username, true) }
        val packed = packServers(updated)
        val editor = preferences.edit().putString("remembered-account-servers", packed)
        if (accountsUrl.equals(url, true) && this.username.equals(username, true)) {
            val fallback = updated.firstOrNull()
            editor.putString("accounts-url", fallback?.url ?: "").putString("account-username", fallback?.username ?: "").putString("computer-url", fallback?.computerUrl ?: "").remove("account-token")
        }
        check(editor.commit())
    }
    fun saveSession(host: String, token: String, deviceId: String) {
        check(preferences.edit().putString(KEY_HOST, host).putString("device-id", deviceId)
            .putString(KEY_TOKEN, encrypt(token)).putBoolean("connection-paused", false).commit()) { "无法保存设备凭据" }
    }
    fun pauseConnection() { check(preferences.edit().putBoolean("connection-paused", true).commit()) }
    private fun packServers(servers: List<RememberedAccountServer>): String = org.json.JSONArray().apply {
        servers.forEach { put(org.json.JSONObject().put("url", it.url).put("username", it.username).put("computerUrl", it.computerUrl)) }
    }.toString()

    @Synchronized fun activateConversationProfile(accountId: String, hostId: String, migrateLegacy: Boolean) {
        val scope = java.security.MessageDigest.getInstance("SHA-256")
            .digest((accountId + "\n" + hostId).encodeToByteArray()).joinToString("") { "%02x".format(it) }
        if (scope == conversationScope) return
        val movingLegacy = conversationScope == null && migrateLegacy
        val target = File(directory, "connections/$scope").apply { mkdirs() }
        if (movingLegacy) {
            listOf("conversation-cache.enc", "submission-journal.enc").forEach { name ->
                val source = File(directory, name)
                if (source.exists()) source.copyTo(File(target, name), overwrite = true)
            }
        }
        check(preferences.edit().putString("conversation-scope", scope).commit())
        if (movingLegacy) listOf("conversation-cache.enc", "submission-journal.enc").forEach { AtomicFile(File(directory, it)).delete() }
    }
    private fun documentFile(name: String): File = conversationScope?.let { File(directory, "connections/$it/$name") } ?: File(directory, name)
    fun readLocal(): String? {
        if (documentFile("conversation-cache.enc").exists()) return if (skipDisplayCache) null else readDocument("conversation-cache.enc")
        if (conversationScope != null) return null
        val old = string("local-state") ?: return null
        if (old.length > 2_000_000) {
            // Preserve the old encrypted blob for recovery; never retry decoding
            // an oversized legacy cache on every launch or erase the login.
            runCatching { File(directory, "legacy-state-quarantined.enc").writeText(old); preferences.edit().remove("local-state").commit() }
            recoveredData = true; return null
        }
        return runCatching { decrypt(old) }.onFailure { recoveredData = true }.getOrNull()
    }
    fun readJournal(): String? = readDocument("submission-journal.enc")
    fun saveLocal(value: String, journal: String) {
        require(value.length <= 1_000_000 && journal.length <= 400_000) { "本地记录过大" }
        writeDocument("submission-journal.enc", journal)
        writeDocument("conversation-cache.enc", value)
        preferences.edit().remove("local-state").apply()
    }
    fun clearDisplayCache() { AtomicFile(documentFile("conversation-cache.enc")).delete() }
    private fun readDocument(name: String): String? {
        val file = AtomicFile(documentFile(name))
        return runCatching {
            file.openRead().use { input ->
                val output = java.io.ByteArrayOutputStream(); val buffer = ByteArray(8192)
                while (output.size() <= 2_000_000) {
                    val count = input.read(buffer); if (count < 0) break
                    output.write(buffer, 0, count)
                }
                val bytes = output.toByteArray()
                check(bytes.size <= 2_000_000)
                decrypt(bytes.decodeToString())
            }
        }.onFailure { if (documentFile(name).exists()) recoveredData = true }.getOrNull()
    }
    private fun writeDocument(name: String, value: String) {
        val file = AtomicFile(documentFile(name)); val stream = file.startWrite()
        try { stream.write(encrypt(value).encodeToByteArray()); file.finishWrite(stream) }
        catch (failure: Exception) { file.failWrite(stream); throw failure }
    }
    private fun encrypt(value: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        return Base64.encodeToString(byteArrayOf(cipher.iv.size.toByte()) + cipher.iv + cipher.doFinal(value.encodeToByteArray()), Base64.NO_WRAP)
    }
    private fun decrypt(packed: String): String {
        val bytes = Base64.decode(packed, Base64.NO_WRAP)
        val ivSize = bytes.first().toInt()
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(1, 1 + ivSize)))
        return cipher.doFinal(bytes.copyOfRange(1 + ivSize, bytes.size)).decodeToString()
    }

    fun token(): String? {
        val packed = string(KEY_TOKEN) ?: return null
        return runCatching {
            val bytes = Base64.decode(packed, Base64.NO_WRAP)
            val ivSize = bytes.first().toInt()
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(1, 1 + ivSize)))
            cipher.doFinal(bytes.copyOfRange(1 + ivSize, bytes.size)).decodeToString()
        }.getOrNull()
    }

    fun saveToken(value: String) {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, key())
        val iv = cipher.iv
        val encrypted = cipher.doFinal(value.encodeToByteArray())
        val packed = byteArrayOf(iv.size.toByte()) + iv + encrypted
        preferences.edit().putString(KEY_TOKEN, Base64.encodeToString(packed, Base64.NO_WRAP)).apply()
    }

    fun clearToken() {
        preferences.edit().remove(KEY_TOKEN).remove("device-id").remove("local-state").remove("account-token").remove("connection-paused").commit()
        listOf("conversation-cache.enc", "submission-journal.enc").forEach { AtomicFile(documentFile(it)).delete() }
    }

    private fun key(): SecretKey {
        val store = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE).run {
            init(KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build())
            generateKey()
        }
    }

    private companion object {
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val KEY_ALIAS = "codexphone-device-token"
        const val KEY_HOST = "host-url"
        const val KEY_TOKEN = "encrypted-device-token"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
    }
}
