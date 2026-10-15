package com.dnm.ai;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.util.Log;

import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import androidx.work.Constraints;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.ExistingWorkPolicy;
import androidx.work.NetworkType;
import androidx.work.PeriodicWorkRequest;
import androidx.work.OneTimeWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.io.InputStream;
import java.io.ByteArrayOutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;

public class UpdateCheckWorker extends Worker {
    private static final String TAG = "DNMUpdateCheck";
    private static final String WORK_NAME = "dnm-daily-update-check";
    private static final String CHANNEL_ID = "dnm-app-updates";
    private static final String RELEASE_API =
            "https://api.github.com/repos/tecno77713-art/dnm-offline-ai/releases/latest";
    private static final String DOWNLOAD_URL =
            "https://github.com/tecno77713-art/dnm-offline-ai/releases/latest/download/DNM-Android.apk";

    public UpdateCheckWorker(@NonNull Context context, @NonNull WorkerParameters workerParams) {
        super(context, workerParams);
    }

    public static void schedule(Context context) {
        Constraints constraints = new Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build();
        OneTimeWorkRequest firstCheck = new OneTimeWorkRequest.Builder(UpdateCheckWorker.class)
                .setConstraints(constraints)
                .build();
        WorkManager.getInstance(context).enqueueUniqueWork(
                WORK_NAME + "-first-check",
                ExistingWorkPolicy.KEEP,
                firstCheck
        );
        PeriodicWorkRequest request = new PeriodicWorkRequest.Builder(
                UpdateCheckWorker.class,
                1,
                TimeUnit.DAYS
        ).setConstraints(constraints).build();
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
                WORK_NAME,
                ExistingPeriodicWorkPolicy.KEEP,
                request
        );
    }

    @NonNull
    @Override
    public Result doWork() {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(RELEASE_API).openConnection();
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(15000);
            connection.setReadTimeout(15000);
            connection.setRequestProperty("Accept", "application/vnd.github+json");
            connection.setRequestProperty("X-GitHub-Api-Version", "2022-11-28");
            connection.setRequestProperty("User-Agent", "DNM-Android");

            int status = connection.getResponseCode();
            if (status != HttpURLConnection.HTTP_OK) {
                Log.e(TAG, "GitHub release check returned HTTP " + status);
                return Result.retry();
            }

            String releaseJson;
            try (InputStream stream = connection.getInputStream()) {
                ByteArrayOutputStream response = new ByteArrayOutputStream();
                byte[] buffer = new byte[4096];
                int bytesRead;
                while ((bytesRead = stream.read(buffer)) != -1) {
                    response.write(buffer, 0, bytesRead);
                }
                releaseJson = response.toString(StandardCharsets.UTF_8.name());
            }

            String latestVersion = normalizeVersion(new JSONObject(releaseJson).getString("tag_name"));
            String installedVersion = normalizeVersion(BuildConfig.VERSION_NAME);
            if (compareVersions(latestVersion, installedVersion) > 0) {
                showUpdateNotification(latestVersion);
            }
            return Result.success();
        } catch (IOException | JSONException | NumberFormatException exception) {
            Log.e(TAG, "Could not check for D:N:M updates.", exception);
            return Result.retry();
        } finally {
            if (connection != null) {
                connection.disconnect();
            }
        }
    }

    private static String normalizeVersion(String version) {
        String normalized = version.startsWith("v") ? version.substring(1) : version;
        if (!normalized.matches("\\d+(\\.\\d+)*")) {
            throw new NumberFormatException("Unexpected D:N:M version format.");
        }
        return normalized;
    }

    private static int compareVersions(String left, String right) {
        String[] leftParts = left.split("\\.");
        String[] rightParts = right.split("\\.");
        int length = Math.max(leftParts.length, rightParts.length);
        for (int index = 0; index < length; index++) {
            long leftNumber = index < leftParts.length ? Long.parseLong(leftParts[index]) : 0;
            long rightNumber = index < rightParts.length ? Long.parseLong(rightParts[index]) : 0;
            int comparison = Long.compare(leftNumber, rightNumber);
            if (comparison != 0) {
                return comparison;
            }
        }
        return 0;
    }

    private void showUpdateNotification(String latestVersion) {
        Context context = getApplicationContext();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
                && ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            Log.i(TAG, "Update available, but notifications are not permitted.");
            return;
        }

        createNotificationChannel(context);
        Intent openDownload = new Intent(Intent.ACTION_VIEW, Uri.parse(DOWNLOAD_URL));
        PendingIntent pendingIntent = PendingIntent.getActivity(
                context,
                0,
                openDownload,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        NotificationCompat.Builder notification = new NotificationCompat.Builder(context, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_sys_download_done)
                .setContentTitle("Hay una nueva versión de D:N:M")
                .setContentText("D:N:M " + latestVersion + " está disponible. Toca para descargarla.")
                .setStyle(new NotificationCompat.BigTextStyle().bigText(
                        "D:N:M " + latestVersion + " está disponible. Toca aquí para descargar la aplicación."
                ))
                .setContentIntent(pendingIntent)
                .setAutoCancel(true)
                .setPriority(NotificationCompat.PRIORITY_DEFAULT);
        NotificationManagerCompat.from(context).notify(1, notification.build());
    }

    private static void createNotificationChannel(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Actualizaciones de D:N:M",
                NotificationManager.IMPORTANCE_DEFAULT
        );
        channel.setDescription("Avisos cuando hay una versión nueva de D:N:M para Android.");
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.createNotificationChannel(channel);
        }
    }
}
