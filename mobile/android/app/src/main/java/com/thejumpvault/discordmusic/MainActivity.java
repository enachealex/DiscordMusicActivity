package com.thejumpvault.discordmusic;

import android.Manifest;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebChromeClient;

public class MainActivity extends BridgeActivity {

    private static final int REQUEST_POST_NOTIFICATIONS = 1001;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        requestNotificationPermissionIfNeeded();

        Bridge bridge = getBridge();
        WebView webView = bridge.getWebView();

        // The web app opens Spotify sign-in and "Add to Discord" with
        // target="_blank". A WebView drops those clicks unless multiple windows
        // are enabled and onCreateWindow is handled — see the chrome client below.
        webView.getSettings().setSupportMultipleWindows(true);
        webView.setWebChromeClient(new ExternalWindowChromeClient(bridge));
    }

    /**
     * From Android 13 a foreground service's media notification is silently not shown
     * without POST_NOTIFICATIONS — and that notification IS the play/pause/skip strip
     * in the shade, so background playback would look broken without it. Asking once
     * here is cheap; the media session itself stays opt-in from inside the app.
     */
    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
        boolean granted =
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED;
        if (granted) return;
        ActivityCompat.requestPermissions(
            this,
            new String[] { Manifest.permission.POST_NOTIFICATIONS },
            REQUEST_POST_NOTIFICATIONS
        );
    }

    /**
     * Keeps Capacitor's default chrome-client behaviour (file chooser, permission
     * prompts, JS dialogs) and adds one thing: a target="_blank" link is handed to
     * the system browser instead of being silently swallowed.
     *
     * Spotify's OAuth round-trip still lands back in the app — the server emits
     * the token over Socket.IO to the originating socket id, so the session that
     * opened the link receives it without needing the popup's window.opener.
     */
    private static class ExternalWindowChromeClient extends BridgeWebChromeClient {

        ExternalWindowChromeClient(Bridge bridge) {
            super(bridge);
        }

        @Override
        public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
            // The requested URL isn't passed in directly: hand the WebView a throwaway
            // child, let it report the navigation it wants, then launch that externally.
            final WebView probe = new WebView(view.getContext());
            probe.setWebViewClient(
                new WebViewClient() {
                    @Override
                    public boolean shouldOverrideUrlLoading(WebView probeView, WebResourceRequest request) {
                        openExternally(probeView, request.getUrl());
                        return true;
                    }
                }
            );

            WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
            transport.setWebView(probe);
            resultMsg.sendToTarget();
            return true;
        }

        private void openExternally(final WebView probeView, Uri url) {
            try {
                Intent intent = new Intent(Intent.ACTION_VIEW, url);
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                probeView.getContext().startActivity(intent);
            } catch (Exception ignored) {
                // No browser installed, or the scheme has no handler — nothing to do.
            }
            // Tear the throwaway WebView down after this callback returns; destroying
            // it mid-callback crashes on some Android versions.
            new Handler(Looper.getMainLooper()).post(probeView::destroy);
        }
    }
}
