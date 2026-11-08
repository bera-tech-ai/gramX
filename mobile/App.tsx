import { StatusBar } from 'expo-status-bar';
import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  BackHandler,
  Platform,
  Pressable,
  SafeAreaView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import WebView, { WebViewNavigation } from 'react-native-webview';

const WEB_APP_URL = process.env.EXPO_PUBLIC_API_URL || 'https://gramxapi-rxttc3xk.manus.space';

export default function App() {
  const NativeWebView = WebView as any;
  const webViewRef = useRef<any>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [canGoBack, setCanGoBack] = useState(false);

  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!canGoBack) return false;
      webViewRef.current?.goBack();
      return true;
    });
    return () => subscription.remove();
  }, [canGoBack]);

  if (failed) {
    return (
      <SafeAreaView style={styles.safe}>
        <StatusBar style="light" />
        <View style={styles.errorPanel}>
          <Text style={styles.brand}>B-MESSENGER</Text>
          <Text style={styles.errorTitle}>Connection unavailable</Text>
          <Text style={styles.errorCopy}>The B-MESSENGER service could not be loaded. Check your connection and try again.</Text>
          <Pressable style={styles.retry} onPress={() => { setFailed(false); setLoading(true); webViewRef.current?.reload(); }}>
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <StatusBar style="light" />
      <View style={styles.container}>
        {loading && (
          <View style={styles.loadingOverlay} pointerEvents="none">
            <ActivityIndicator size="large" color="#7C5CFC" />
            <Text style={styles.loadingText}>Loading B-MESSENGER…</Text>
          </View>
        )}
        <NativeWebView
          ref={webViewRef}
          source={{ uri: WEB_APP_URL }}
          style={styles.webView}
          originWhitelist={['*']}
          javaScriptEnabled
          domStorageEnabled
          setSupportMultipleWindows={false}
          allowsInlineMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          sharedCookiesEnabled
          thirdPartyCookiesEnabled
          allowsFullscreenVideo
          pullToRefreshEnabled={Platform.OS === 'android'}
          userAgent="B-MESSENGER-Android/1.0"
          injectedJavaScriptBeforeContentLoaded="window.__B_MESSENGER_NATIVE_SHELL__ = true; true;"
          onLoadStart={() => { setLoading(true); setFailed(false); }}
          onLoadEnd={() => setLoading(false)}
          onError={() => { setLoading(false); setFailed(true); }}
          onNavigationStateChange={(state: WebViewNavigation) => setCanGoBack(state.canGoBack)}
          onHttpError={(event: any) => {
            if (event.nativeEvent.statusCode >= 500) setFailed(true);
          }}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#0A0F1F' },
  container: { flex: 1, backgroundColor: '#0A0F1F' },
  webView: { flex: 1, backgroundColor: '#0A0F1F' },
  loadingOverlay: {
    ...StyleSheet.absoluteFill,
    zIndex: 2,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#0A0F1F',
  },
  loadingText: { color: '#AEB8D3', marginTop: 14, fontSize: 14 },
  errorPanel: { flex: 1, padding: 28, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0A0F1F' },
  brand: { color: '#FFF', fontSize: 25, fontWeight: '900', letterSpacing: 1 },
  errorTitle: { color: '#FFF', fontSize: 21, fontWeight: '800', marginTop: 28 },
  errorCopy: { color: '#AEB8D3', textAlign: 'center', lineHeight: 22, marginTop: 10, maxWidth: 340 },
  retry: { marginTop: 24, backgroundColor: '#7C5CFC', borderRadius: 14, paddingHorizontal: 24, paddingVertical: 14 },
  retryText: { color: '#FFF', fontWeight: '800' },
});
