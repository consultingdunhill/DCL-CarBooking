# Fleet mobile app (Capacitor)

The iOS/Android app wraps the same React build as the web app (`apps/web`). Staff run their trips from it because only a native app can track GPS reliably in the background and see exactly when location is switched off.

## Build and run

```bash
# 1. Build the web app against the public API (not localhost: the phone can't reach it)
VITE_API_URL=https://fleet-api.example.co.ke VITE_AUTH_MODE=entra pnpm --filter @carbooking/web build

# 2. First time only: create the native projects
cd apps/mobile
npx cap add android
npx cap add ios          # needs macOS + Xcode + CocoaPods

# 3. Copy the web build and plugins into the native projects
npx cap sync

# 4. Open in Android Studio / Xcode and run on a device
npx cap open android
npx cap open ios
```

Commit `android/` and `ios/` once created: the native settings below live there.

## Native settings to add after `cap add`

### Both platforms
- **Transistorsoft background geolocation**: follow the plugin's Capacitor setup guide for v7 (Gradle and Podfile steps). **Android release builds need the paid licence key** in `AndroidManifest.xml` (`com.transistorsoft.locationmanager.license`). Debug builds work without it.
- **Microsoft sign-in redirect**: the app signs in through the system browser and comes back on `ke.co.fleet.app://auth` (set `VITE_ENTRA_NATIVE_REDIRECT` if you change the app ID). Register it as a *Mobile and desktop applications* redirect URI on the Entra app registration.
- **Push (FCM)**: add `google-services.json` (Android) and `GoogleService-Info.plist` + APNs key (iOS) from the Firebase project.

### iOS (`ios/App/App/Info.plist`)
```xml
<key>NSLocationAlwaysAndWhenInUseUsageDescription</key>
<string>Fleet records the car's location during trips you run, from start until the car is back at the office. It never tracks you outside a trip.</string>
<key>NSLocationWhenInUseUsageDescription</key>
<string>Fleet records the car's location during trips you run.</string>
<key>NSMotionUsageDescription</key>
<string>Motion detection saves battery by pausing GPS while the car is parked.</string>
<key>NSCameraUsageDescription</key>
<string>Take a photo of the odometer at the start and end of a trip.</string>
<key>UIBackgroundModes</key>
<array><string>location</string><string>fetch</string><string>remote-notification</string></array>
<key>CFBundleURLTypes</key>
<array><dict><key>CFBundleURLSchemes</key><array><string>ke.co.fleet.app</string></array></dict></array>
```

### Android (`android/app/src/main/AndroidManifest.xml`)
Inside `<activity>` add the sign-in redirect:
```xml
<intent-filter>
  <action android:name="android.intent.action.VIEW" />
  <category android:name="android.intent.category.DEFAULT" />
  <category android:name="android.intent.category.BROWSABLE" />
  <data android:scheme="ke.co.fleet.app" android:host="auth" />
</intent-filter>
```
Permissions (`ACCESS_BACKGROUND_LOCATION`, foreground service, etc.) are merged in by the geolocation plugin. Add `<uses-permission android:name="android.permission.CAMERA" />` for odometer photos.

## Store distribution (BYOD)
- Register **Organisation** developer accounts with Apple and Google (needs a D-U-N-S number).
- iOS: request **Unlisted App Distribution**. Google Play: normal listing; only Microsoft 365 accounts with the Staff/Admin role can sign in.
- Both stores ask for a written justification and a short demo video for **background location**. Show: privacy notice → start trip → tracking notification → end trip → tracking stops.

## Field testing checklist
Test on an iPhone and on the Android brands staff actually use (Tecno, Infinix, Samsung, Xiaomi). Their battery savers kill background apps: the in-app guide is at **Me → Keep trip tracking running**. Run acceptance tests 4–8, 11 and 12 from `DEVELOPMENT_PLAN.md` §8 on real devices: location off, mobile data off for 20 minutes, force-quit, back-at-office prompt, overdue alerts, battery use over a 4-hour trip, and stop arrival times.
