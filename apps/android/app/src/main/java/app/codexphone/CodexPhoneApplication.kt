package app.codexphone

import android.app.Application
import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.os.Build
import java.io.File

class CodexPhoneApplication : Application() {
    var recoveredAfterCrash = false
        private set
    override fun onCreate() {
        super.onCreate()
        val marker = File(filesDir, "last-crash.txt")
        recoveredAfterCrash = marker.exists()
        if (Build.VERSION.SDK_INT >= 30) {
            runCatching {
                val exit = getSystemService(ActivityManager::class.java).getHistoricalProcessExitReasons(null, 0, 1).firstOrNull()
                val handledAt = getSharedPreferences("startup-health", 0).getLong("handled-exit", 0)
                if (exit != null && exit.timestamp > handledAt && exit.reason in listOf(ApplicationExitInfo.REASON_CRASH,
                        ApplicationExitInfo.REASON_CRASH_NATIVE, ApplicationExitInfo.REASON_ANR, ApplicationExitInfo.REASON_LOW_MEMORY)) {
                    recoveredAfterCrash = true
                    getSharedPreferences("startup-health", 0).edit().putLong("handled-exit", exit.timestamp).apply()
                }
            }
        }
        if (marker.exists()) runCatching { marker.renameTo(File(filesDir, "previous-crash.txt")) }
        val previous = Thread.getDefaultUncaughtExceptionHandler()
        Thread.setDefaultUncaughtExceptionHandler { thread, failure ->
            // Do not include exception messages, prompts, tokens or response data.
            runCatching { marker.writeText(failure.javaClass.name + "\n" + failure.stackTrace.take(35).joinToString("\n")) }
            previous?.uncaughtException(thread, failure)
        }
    }
}
