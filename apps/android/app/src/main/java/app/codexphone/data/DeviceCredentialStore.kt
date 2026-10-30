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

class DeviceCredentialStore(context: Context) {
    private val preferences = context.getSharedPreferences("device-connection", Context.MODE_PRIVATE)

    var hostUrl: String?
        get() = preferences.getString(KEY_HOST, null)
        set(value) { preferences.edit().putString(KEY_HOST, value).apply() }

    val deviceId: String? get() = preferences.getString("device-id", null)
    fun saveSession(host: String, token: String, deviceId: String) {
        check(preferences.edit().putString(KEY_HOST, host).putString("device-id", deviceId)
            .putString(KEY_TOKEN, encrypt(token)).commit()) { "无法保存设备凭据" }
    }
    fun readLocal(): String? = preferences.getString("local-state", null)?.let { runCatching { decrypt(it) }.getOrNull() }
    fun saveLocal(value: String) {
        check(preferences.edit().putString("local-state", encrypt(value)).commit()) { "无法保存本地状态" }
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
        val packed = preferences.getString(KEY_TOKEN, null) ?: return null
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

    fun clearToken() { preferences.edit().remove(KEY_TOKEN).remove("device-id").remove("local-state").commit() }

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
