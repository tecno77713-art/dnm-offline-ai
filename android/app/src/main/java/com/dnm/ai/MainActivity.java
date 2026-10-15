package com.dnm.ai;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Bundle;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ProgressBar;
import android.widget.Toast;
import android.Manifest;
import android.content.pm.PackageManager;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.Voice;
import android.provider.MediaStore;
import androidx.core.content.FileProvider;
import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import android.os.Build;
import android.util.Log;

import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Set;

public class MainActivity extends Activity {
    private static final String HOME_URL = "https://tecno77713-art.github.io/dnm-offline-ai/?androidApp=1";
    private static final int FILE_CHOOSER_REQUEST = 1;
    private static final int NOTIFICATION_PERMISSION_REQUEST = 2;
    private static final int CAMERA_REQUEST = 3;
    private static final int MICROPHONE_PERMISSION_REQUEST = 4;

    private WebView webView;
    private ProgressBar progressBar;
    private android.webkit.ValueCallback<Uri[]> fileChooserCallback;
    private Uri pendingCameraUri;
    private File pendingCameraFile;
    private SpeechRecognizer speechRecognizer;
    private TextToSpeech textToSpeech;
    private boolean textToSpeechReady;
    private boolean launchedBrowserFallback;

    private final class DnmBridge {
        @JavascriptInterface
        public void startOfflineSpeechRecognition() {
            runOnUiThread(() -> beginOfflineSpeechRecognition());
        }

        @JavascriptInterface
        public void speakText(String text) {
            runOnUiThread(() -> speakLocally(text));
        }

        @JavascriptInterface
        public void stopSpeaking() {
            runOnUiThread(() -> {
                if (textToSpeech != null) {
                    textToSpeech.stop();
                }
            });
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        UpdateCheckWorker.schedule(this);
        textToSpeech = new TextToSpeech(this, status -> {
            if (status == TextToSpeech.SUCCESS) {
                textToSpeechReady = true;
                selectLocalSpanishVoice();
            } else {
                notifyWeb("DNMNativeSpeechError", "El teléfono no pudo iniciar la voz local.");
            }
        });

        android.widget.FrameLayout root = new android.widget.FrameLayout(this);
        webView = new WebView(this);
        progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
        progressBar.setMax(100);
        root.addView(webView, new android.widget.FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
        ));
        android.widget.FrameLayout.LayoutParams progressLayout = new android.widget.FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                (int) (3 * getResources().getDisplayMetrics().density)
        );
        root.addView(progressBar, progressLayout);
        setContentView(root);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportZoom(false);
        settings.setTextZoom(100);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
        webView.addJavascriptInterface(new DnmBridge(), "DNMAndroid");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (isTrustedAppUrl(uri)) {
                    return false;
                }
                if ("about".equals(uri.getScheme()) && "blank".equals(uri.getSchemeSpecificPart())) {
                    return true;
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (ActivityNotFoundException exception) {
                    Toast.makeText(MainActivity.this, "No se pudo abrir ese enlace.", Toast.LENGTH_SHORT).show();
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                if (launchedBrowserFallback || !HOME_URL.equals(url)) {
                    return;
                }
                view.evaluateJavascript(
                        "(async()=>{try{return Boolean(navigator.gpu&&await navigator.gpu.requestAdapter())}catch{return false}})()",
                        hasGpu -> {
                            if (!"false".equals(hasGpu) || launchedBrowserFallback) {
                                return;
                            }
                            try {
                                startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(HOME_URL)));
                                launchedBrowserFallback = true;
                                Toast.makeText(
                                        MainActivity.this,
                                        "Abriendo D:N:M en Chrome para usar la IA local.",
                                        Toast.LENGTH_LONG
                                ).show();
                                finish();
                            } catch (ActivityNotFoundException exception) {
                                Toast.makeText(
                                        MainActivity.this,
                                        "Este dispositivo no tiene un navegador compatible con la IA local.",
                                        Toast.LENGTH_LONG
                                ).show();
                            }
                        }
                );
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                super.onPageStarted(view, url, favicon);
                Uri uri = Uri.parse(url);
                if (!isTrustedAppUrl(uri) && !("about".equals(uri.getScheme()) && "blank".equals(uri.getSchemeSpecificPart()))) {
                    view.stopLoading();
                    view.loadUrl("about:blank");
                }
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progressBar.setProgress(newProgress);
                progressBar.setVisibility(newProgress >= 100 ? ProgressBar.GONE : ProgressBar.VISIBLE);
            }

            @Override
            public boolean onShowFileChooser(
                    WebView view,
                    android.webkit.ValueCallback<Uri[]> callback,
                    FileChooserParams params
            ) {
                if (fileChooserCallback != null) {
                    fileChooserCallback.onReceiveValue(null);
                }
                fileChooserCallback = callback;
                Intent chooser = params.createIntent();
                try {
                    if (params.isCaptureEnabled()) {
                        openCameraOrFilePicker(chooser);
                    } else {
                        startActivityForResult(chooser, FILE_CHOOSER_REQUEST);
                    }
                } catch (ActivityNotFoundException exception) {
                    fileChooserCallback = null;
                    callback.onReceiveValue(null);
                    Toast.makeText(MainActivity.this, "No se encontró la cámara ni un selector de fotos.", Toast.LENGTH_SHORT).show();
                    return false;
                }
                return true;
            }
        });

        webView.loadUrl(HOME_URL);
        requestNotificationPermission();
    }

    private boolean isTrustedAppUrl(Uri uri) {
        String path = uri.getPath();
        return "https".equals(uri.getScheme())
                && "tecno77713-art.github.io".equals(uri.getHost())
                && (uri.getPort() == -1 || uri.getPort() == 443)
                && uri.getUserInfo() == null
                && path != null
                && ("/dnm-offline-ai".equals(path) || path.startsWith("/dnm-offline-ai/"));
    }

    private void openCameraOrFilePicker(Intent fallbackPicker) {
        Intent cameraIntent = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
        if (cameraIntent.resolveActivity(getPackageManager()) == null) {
            startActivityForResult(fallbackPicker, FILE_CHOOSER_REQUEST);
            return;
        }

        try {
            File cameraDirectory = new File(getCacheDir(), "camera");
            if (!cameraDirectory.exists() && !cameraDirectory.mkdirs()) {
                throw new IOException("No se pudo preparar la cámara.");
            }
            pendingCameraFile = File.createTempFile("dnm-photo-", ".jpg", cameraDirectory);
            pendingCameraUri = FileProvider.getUriForFile(
                    this,
                    BuildConfig.APPLICATION_ID + ".fileprovider",
                    pendingCameraFile
            );
            cameraIntent.putExtra(MediaStore.EXTRA_OUTPUT, pendingCameraUri);
            cameraIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION);
            startActivityForResult(cameraIntent, CAMERA_REQUEST);
        } catch (IOException | ActivityNotFoundException exception) {
            Log.e("DNMCamera", "Could not open the camera.", exception);
            if (pendingCameraFile != null) {
                pendingCameraFile.delete();
            }
            pendingCameraUri = null;
            pendingCameraFile = null;
            startActivityForResult(fallbackPicker, FILE_CHOOSER_REQUEST);
        }
    }

    private void requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU
                || ContextCompat.checkSelfPermission(this, "android.permission.POST_NOTIFICATIONS")
                == PackageManager.PERMISSION_GRANTED) {
            return;
        }
        ActivityCompat.requestPermissions(
                this,
                new String[]{"android.permission.POST_NOTIFICATIONS"},
                NOTIFICATION_PERMISSION_REQUEST
        );
    }

    private void beginOfflineSpeechRecognition() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S
                || !SpeechRecognizer.isOnDeviceRecognitionAvailable(this)) {
            notifyWeb("DNMNativeSpeechError", "Este teléfono no ofrece reconocimiento de voz sin conexión.");
            return;
        }

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO)
                != PackageManager.PERMISSION_GRANTED) {
            ActivityCompat.requestPermissions(
                    this,
                    new String[]{Manifest.permission.RECORD_AUDIO},
                    MICROPHONE_PERMISSION_REQUEST
            );
            return;
        }

        destroySpeechRecognizer();
        speechRecognizer = SpeechRecognizer.createOnDeviceSpeechRecognizer(this);
        speechRecognizer.setRecognitionListener(new RecognitionListener() {
            @Override
            public void onReadyForSpeech(Bundle params) {
                notifyWeb("DNMNativeSpeechStatus", "Habla ahora. El dictado se procesa en este teléfono.");
            }

            @Override
            public void onBeginningOfSpeech() { }

            @Override
            public void onRmsChanged(float rmsdB) { }

            @Override
            public void onBufferReceived(byte[] buffer) { }

            @Override
            public void onEndOfSpeech() {
                notifyWeb("DNMNativeSpeechStatus", "Procesando el dictado en este teléfono…");
            }

            @Override
            public void onError(int error) {
                String message = error == SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE
                        || error == SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED
                        ? "Instala el paquete de reconocimiento de voz sin conexión en español desde los ajustes de Android."
                        : "No se entendió la voz o el reconocimiento local no está disponible. Inténtalo otra vez.";
                notifyWeb("DNMNativeSpeechError", message);
                releaseSpeechRecognizer();
            }

            @Override
            public void onResults(Bundle results) {
                ArrayList<String> alternatives = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                if (alternatives == null || alternatives.isEmpty()) {
                    notifyWeb("DNMNativeSpeechError", "No se reconocieron palabras. Inténtalo otra vez.");
                } else {
                    notifyWeb("DNMNativeTranscript", alternatives.get(0));
                }
                releaseSpeechRecognizer();
            }

            @Override
            public void onPartialResults(Bundle partialResults) { }

            @Override
            public void onEvent(int eventType, Bundle params) { }
        });

        Intent recognitionIntent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        recognitionIntent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        recognitionIntent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, "es-ES");
        recognitionIntent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, "es-ES");
        recognitionIntent.putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true);
        try {
            speechRecognizer.startListening(recognitionIntent);
        } catch (RuntimeException exception) {
            Log.e("DNMSpeech", "Could not start on-device speech recognition.", exception);
            notifyWeb("DNMNativeSpeechError", "No se pudo iniciar el reconocimiento de voz sin conexión.");
            releaseSpeechRecognizer();
        }
    }

    private void releaseSpeechRecognizer() {
        destroySpeechRecognizer();
        notifyWeb("DNMNativeSpeechFinished", "");
    }

    private void destroySpeechRecognizer() {
        if (speechRecognizer != null) {
            speechRecognizer.destroy();
            speechRecognizer = null;
        }
    }

    private void selectLocalSpanishVoice() {
        if (textToSpeech == null || !textToSpeechReady) {
            return;
        }
        Set<Voice> voices = textToSpeech.getVoices();
        Voice spanishVoice = null;
        if (voices != null) {
            for (Voice voice : voices) {
                if (!voice.isNetworkConnectionRequired()
                        && "es".equalsIgnoreCase(voice.getLocale().getLanguage())) {
                    spanishVoice = voice;
                    if ("ES".equalsIgnoreCase(voice.getLocale().getCountry())) {
                        break;
                    }
                }
            }
        }
        if (spanishVoice != null) {
            textToSpeech.setVoice(spanishVoice);
        }
    }

    private void speakLocally(String text) {
        if (text == null || text.trim().isEmpty()) {
            return;
        }
        if (!textToSpeechReady || textToSpeech == null) {
            notifyWeb("DNMNativeSpeechError", "La voz local todavía no está lista.");
            return;
        }
        Voice voice = textToSpeech.getVoice();
        if (voice == null || voice.isNetworkConnectionRequired()
                || !"es".equalsIgnoreCase(voice.getLocale().getLanguage())) {
            notifyWeb("DNMNativeSpeechError", "Instala una voz española sin conexión desde los ajustes de texto a voz de Android.");
            return;
        }
        int result = textToSpeech.speak(text, TextToSpeech.QUEUE_FLUSH, null, "dnm-response");
        if (result == TextToSpeech.ERROR) {
            notifyWeb("DNMNativeSpeechError", "No se pudo reproducir la voz local.");
        }
    }

    private void notifyWeb(String callback, String message) {
        if (webView == null) {
            return;
        }
        String safeMessage = org.json.JSONObject.quote(message == null ? "" : message);
        runOnUiThread(() -> {
            if (webView != null) {
                webView.evaluateJavascript(
                        "if(window." + callback + ")window." + callback + "(" + safeMessage + ")",
                        null
                );
            }
        });
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == MICROPHONE_PERMISSION_REQUEST) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                beginOfflineSpeechRecognition();
            } else {
                notifyWeb("DNMNativeSpeechError", "Para dictar sin conexión, permite el acceso al micrófono.");
            }
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == CAMERA_REQUEST) {
            boolean photoReady = resultCode == RESULT_OK && pendingCameraFile != null && pendingCameraFile.length() > 0;
            Uri[] results = photoReady
                    ? new Uri[]{pendingCameraUri}
                    : null;
            if (!photoReady && pendingCameraFile != null) {
                pendingCameraFile.delete();
            }
            pendingCameraUri = null;
            pendingCameraFile = null;
            if (fileChooserCallback != null) {
                fileChooserCallback.onReceiveValue(results);
                fileChooserCallback = null;
            }
            return;
        }
        if (requestCode != FILE_CHOOSER_REQUEST || fileChooserCallback == null) {
            return;
        }
        Uri[] results = resultCode == RESULT_OK && data != null
                ? WebChromeClient.FileChooserParams.parseResult(resultCode, data)
                : null;
        fileChooserCallback.onReceiveValue(results);
        fileChooserCallback = null;
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        if (fileChooserCallback != null) {
            fileChooserCallback.onReceiveValue(null);
            fileChooserCallback = null;
        }
        releaseSpeechRecognizer();
        if (textToSpeech != null) {
            textToSpeech.stop();
            textToSpeech.shutdown();
            textToSpeech = null;
        }
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
