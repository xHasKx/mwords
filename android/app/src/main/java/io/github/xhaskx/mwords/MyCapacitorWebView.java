package io.github.xhaskx.mwords;

import android.content.Context;
import android.util.AttributeSet;
import android.util.Log;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import com.getcapacitor.CapacitorWebView;

/**
 * Subclass of Capacitor's WebView that forbids the IME from entering
 * fullscreen / extract-UI mode. Some IMEs (notably Samsung's Cyrillic
 * keyboard) replace the WebView's UI with their own "extract view" of
 * just the focused input, shrinking the WebView's viewport to ~52 CSS
 * px regardless of windowSoftInputMode.
 *
 * Loaded via res/layout/capacitor_bridge_layout_main.xml in this app,
 * which overrides Capacitor's library version by Android's resource
 * priority rules. The bridge's `instanceof CapacitorWebView` check
 * still passes because we extend that class.
 */
public class MyCapacitorWebView extends CapacitorWebView {

    public MyCapacitorWebView(Context context, AttributeSet attrs) {
        super(context, attrs);
        Log.i("mwords", "MyCapacitorWebView instantiated");
    }

    @Override
    public InputConnection onCreateInputConnection(EditorInfo outAttrs) {
        InputConnection ic = super.onCreateInputConnection(outAttrs);
        if (outAttrs != null) {
            outAttrs.imeOptions |=
                EditorInfo.IME_FLAG_NO_FULLSCREEN | EditorInfo.IME_FLAG_NO_EXTRACT_UI;
        }
        return ic;
    }
}
