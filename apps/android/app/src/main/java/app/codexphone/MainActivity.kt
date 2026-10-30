package app.codexphone

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.viewModels
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.ui.graphics.Color
import androidx.core.view.WindowCompat
import app.codexphone.ui.CodexPhoneApp
import app.codexphone.ui.PhoneViewModel

class MainActivity : ComponentActivity() {
    private val viewModel by viewModels<PhoneViewModel>()
    override fun onStart() { super.onStart(); viewModel.setForeground(true) }
    override fun onStop() { viewModel.setForeground(false); super.onStop() }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowCompat.getInsetsController(window, window.decorView).apply {
            isAppearanceLightStatusBars = true
            isAppearanceLightNavigationBars = true
        }
        setContent {
            MaterialTheme(colorScheme = lightColorScheme(
                primary = Color(0xFF315FCA),
                onPrimary = Color.White,
                secondary = Color(0xFF176B62),
                background = Color(0xFFF4F7FF),
                surface = Color.White,
                onSurface = Color(0xFF17223B),
                onSurfaceVariant = Color(0xFF65718A),
            )) {
                CodexPhoneApp(viewModel)
            }
        }
    }
}
