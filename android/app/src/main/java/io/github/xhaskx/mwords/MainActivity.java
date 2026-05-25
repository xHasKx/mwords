package io.github.xhaskx.mwords;

import android.os.Bundle;
import androidx.activity.EdgeToEdge;
import androidx.core.splashscreen.SplashScreen;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Activates the AndroidX SplashScreen compat handler. Without this
        // call the `postSplashScreenTheme` attribute on AppTheme.NoActionBarLaunch
        // is ignored — the launch theme stays as the activity's runtime
        // theme and splash.png remains the windowBackground (visible in
        // status/nav-bar zones and when the keyboard resizes the WebView).
        // Must run before super.onCreate.
        SplashScreen.installSplashScreen(this);
        // Edge-to-edge mode so WindowInsets reach the WebView and
        // env(safe-area-inset-*) resolves to real values in CSS.
        EdgeToEdge.enable(this);
        super.onCreate(savedInstanceState);
    }
}
