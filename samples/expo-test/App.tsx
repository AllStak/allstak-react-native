import { useEffect, useRef, useState } from 'react';
import { Button, ScrollView, StyleSheet, Text, View, Platform, AppState } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { NavigationContainer, useNavigationContainerRef } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import {
  AllStak,
  AllStakProvider,
  drainPendingNativeCrashes,
  __devTriggerNativeCrash,
  instrumentReactNavigation,
} from '@allstak/react-native';

// Point to the LIVE local backend used by the verification pass.
// Replace these with your AllStak project key in real apps.
const ALLSTAK_API_KEY = 'ask_rn_verify_3fee3956d961f32a8d5baf9efdd8aa4f';

// Set to true to auto-fire a representative event sequence on mount
// (used by the SDK production-readiness verification pass to confirm
// payloads land in the live backend without needing manual button taps).
const DEV_AUTO_FIRE = true;
// Set to true ONCE to schedule a native crash 4s after launch. After
// the crash, set this to false, relaunch, and drainPendingNativeCrashes
// (already wired in the provider's useEffect) will ship it to the backend.
const ARM_NATIVE_CRASH = false;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Hardcoded for verification / dev only — production apps must use the
// public ingest host. iOS sim reaches host via localhost; Android emulator
// uses 10.0.2.2 to map to the host.
const HOST_FOR_PLATFORM =
  Platform.OS === 'android' ? 'http://10.0.2.2:8080' : 'http://localhost:8080';

const Stack = createNativeStackNavigator();

function CrashingChild(): React.ReactElement {
  throw new Error('CrashingChild render error');
}

function HomeScreen({ navigation }: any): React.ReactElement {
  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>Home</Text>
      <Text style={styles.help}>
        AllStak verification sample. Tap a button to send a sample event,
        navigate, or trigger a render error / native crash.
      </Text>

      <Section label="Manual capture">
        <Button title="captureException" onPress={() => AllStak.captureException(new Error('manual button press'))} />
        <Button title="captureMessage info" onPress={() => AllStak.captureMessage('Home button captured a message', 'info')} />
        <Button title="captureMessage error" onPress={() => AllStak.captureMessage('Home button captured an error', 'error')} />
      </Section>

      <Section label="Auto capture (drives breadcrumbs that attach to next exception)">
        <Button title="console.warn" onPress={() => console.warn('warning from Home', { tab: 'home' })} />
        <Button title="console.error" onPress={() => console.error('error from Home', { tab: 'home' })} />
        <Button title="fetch 200" onPress={() => fetch('https://httpbin.org/status/200').catch(() => {})} />
        <Button title="fetch 404" onPress={() => fetch('https://httpbin.org/status/404').catch(() => {})} />
        <Button title="fetch 500" onPress={() => fetch('https://httpbin.org/status/500').catch(() => {})} />
        <Button title="fetch network failure" onPress={() => fetch('https://no-such-host-allstak-test.invalid/').catch(() => {})} />
        <Button title="unhandled rejection" onPress={() => Promise.reject(new Error('unhandled-rejection from Home'))} />
        <Button title="Throw uncaught (ErrorUtils)" onPress={() => setTimeout(() => { throw new Error('uncaught timeout error'); }, 0)} />
      </Section>

      <Section label="Navigation">
        <Button title="Go to Products" onPress={() => navigation.navigate('Products')} />
        <Button title="Go to Profile" onPress={() => navigation.navigate('Profile')} />
      </Section>

      <Section label="Render error (boundary catches it, fallback renders)">
        <CrashOnDemand />
      </Section>

      <Section label="DEV-ONLY native crash (kills the app — relaunch to drain)">
        <Text style={styles.warn}>⚠ Triggers a real native crash. Backgrounds the app. Reopen to send.</Text>
        <Button color="#c00" title="DEV: Trigger native crash now" onPress={() => __devTriggerNativeCrash()} />
      </Section>

      <StatusBar style="auto" />
    </ScrollView>
  );
}

function CrashOnDemand(): React.ReactElement {
  const [crash, setCrash] = useState(false);
  if (crash) return <CrashingChild />;
  return <Button title="Trigger render-time error" onPress={() => setCrash(true)} />;
}

function ProductsScreen({ navigation }: any): React.ReactElement {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Products</Text>
      <Text style={styles.help}>
        Navigation here should auto-emit a Home -&gt; Products breadcrumb.
      </Text>
      <Button title="Go to Profile" onPress={() => navigation.navigate('Profile')} />
      <Button title="Back to Home" onPress={() => navigation.navigate('Home')} />
      <Button
        title="Capture exception with breadcrumb context"
        onPress={() => AllStak.captureException(new Error('error from Products'))}
      />
    </View>
  );
}

function ProfileScreen({ navigation }: any): React.ReactElement {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Profile</Text>
      <Button title="Back to Home" onPress={() => navigation.navigate('Home')} />
      <Button title="Back to Products" onPress={() => navigation.navigate('Products')} />
    </View>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }): React.ReactElement {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{label}</Text>
      {children}
    </View>
  );
}

// Inner shell that owns the navigation ref so we can wire the manual
// fallback `instrumentReactNavigation(navigationRef)` (auto-patch is
// not feasible on Metro — see SDK docs).
function NavShell(): React.ReactElement {
  const navigationRef = useNavigationContainerRef();
  return (
    <NavigationContainer
      ref={navigationRef}
      onReady={() => {
        try {
          instrumentReactNavigation(navigationRef as any);
          // eslint-disable-next-line no-console
          console.log('[verify] manual instrumentReactNavigation wired');
        } catch (e: any) {
          // eslint-disable-next-line no-console
          console.log('[verify] instrumentReactNavigation err', e?.message);
        }
      }}
    >
      <Stack.Navigator initialRouteName="Home">
        <Stack.Screen name="Home" component={HomeScreen} />
        <Stack.Screen name="Products" component={ProductsScreen} />
        <Stack.Screen name="Profile" component={ProfileScreen} />
      </Stack.Navigator>
      <AutoFireHarness navigationRef={navigationRef} />
    </NavigationContainer>
  );
}

// Side-render that throws on render — the AllStakProvider's boundary
// catches it and posts an event with metadata.source=AllStakProvider.ErrorBoundary.
function RenderErrorTrigger(): React.ReactElement {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    // Wait for the harness to finish (~3-4s) before triggering the
    // render error so its captures reach the backend before the boundary
    // unmounts the children subtree.
    const t = setTimeout(() => setArmed(true), 7000);
    return () => clearTimeout(t);
  }, []);
  if (armed) {
    throw new Error('ios-sim2: render error from RenderErrorTrigger');
  }
  return null as any;
}

// Lives inside <NavigationContainer> so it can drive route transitions.
function AutoFireHarness({ navigationRef }: { navigationRef: any }): React.ReactElement {
  useEffect(() => {
    if (!DEV_AUTO_FIRE) return;
    const fire = async () => {
      console.log('[verify] === starting verification harness ===');

      // 1. Health probe
      try {
        const r = await fetch(HOST_FOR_PLATFORM + '/actuator/health');
        console.log('[verify] backend health', r.status);
      } catch (e: any) { console.log('[verify] health FAILED', e?.message); }

      // 2. Manual capture path — establishes that platform/dist/sdk tags land
      console.log('[verify] firing captureException #1');
      AllStak.captureException(new Error('ios-sim2: manual exception #1'));
      await AllStak.flush(5000);

      console.log('[verify] firing captureMessage info');
      AllStak.captureMessage('ios-sim2: manual info log', 'info');
      await delay(120);

      // 3. Drive React Navigation transitions — manual instrumentation
      // should record a Home -> Products and Products -> Profile breadcrumb.
      console.log('[verify] navigating Home -> Products -> Profile -> Home');
      try {
        navigationRef.current?.navigate('Products');
        await delay(200);
        navigationRef.current?.navigate('Profile');
        await delay(200);
        navigationRef.current?.navigate('Home');
        await delay(200);
      } catch (e: any) { console.log('[verify] nav err', e?.message); }

      // 4. Console capture — warn + error should land; log + info should NOT
      console.log('[verify] firing console calls');
      console.log('ios-sim2: log line — should NOT appear in breadcrumbs');
      // @ts-ignore
      console.info('ios-sim2: info line — should NOT appear in breadcrumbs');
      console.warn('ios-sim2: warn line — SHOULD land at level=warn', { from: 'harness' });
      console.error('ios-sim2: error line — SHOULD land at level=error', { from: 'harness' });
      await delay(150);

      // 5. HTTP breadcrumbs — 200 / 4xx / 5xx / network failure
      console.log('[verify] firing fetch breadcrumbs');
      try { await fetch('https://httpbin.org/status/200'); } catch {}
      try { await fetch('https://httpbin.org/status/404'); } catch {}
      try { await fetch('https://httpbin.org/status/500'); } catch {}
      try { await fetch('https://no-such-host-allstak-test.invalid/'); } catch {}
      await delay(200);

      // 6. AppState — simulate background/foreground via the listener
      // Note: real iOS sim transitions fire on Cmd+Shift+H. For
      // verification-without-keypress we rely on the listener being
      // registered by installReactNative. The listener fires breadcrumbs
      // automatically; we just need to verify the listener exists by
      // emitting a synthetic change via AppState's testing API. Since
      // AppState doesn't expose a dispatch in production RN, this branch
      // only verifies the listener is registered (the breadcrumbs from
      // a real background transition would land on the next foreground).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const appStateLog = (AppState as any).currentState ?? 'unknown';
      console.log('[verify] AppState.currentState =', appStateLog);

      // 7. Unhandled promise rejection — should land with source=unhandledRejection
      console.log('[verify] firing unhandled rejection');
      Promise.reject(new Error('ios-sim2: unhandled rejection from harness'));
      await delay(300);

      // 8. ErrorUtils global throw — should land with source=react-native-ErrorUtils
      console.log('[verify] firing global throw via setTimeout');
      setTimeout(() => { throw new Error('ios-sim2: ErrorUtils global error from harness'); }, 0);
      await delay(300);

      // 9. Final capture — drains all the breadcrumbs accumulated above
      console.log('[verify] firing final exception with breadcrumbs');
      AllStak.captureException(new Error('ios-sim2: final exception with breadcrumbs'));
      const flushed = await AllStak.flush(5000);
      console.log('[verify] final flushed:', flushed);
      console.log('[verify] === harness complete ===');
    };
    // Slight delay so navigationRef is wired
    const t = setTimeout(() => { fire().catch(e => console.log('[verify] harness err', e)); }, 800);
    return () => clearTimeout(t);
  }, [navigationRef]);

  return null as any;
}

export default function App(): React.ReactElement {
  // Drain any native crash stashed on the previous launch BEFORE the
  // first user interaction so it ships to the dashboard early.
  useEffect(() => {
    drainPendingNativeCrashes('expo-test@1.0.0')
      .then(() => console.log('[verify] drainPendingNativeCrashes done'))
      .catch((e) => console.log('[verify] drainPendingNativeCrashes err', String(e)));
  }, []);

  useEffect(() => {
    if (!ARM_NATIVE_CRASH) return;
    const t = setTimeout(() => {
      console.log('[verify] firing __devTriggerNativeCrash NOW');
      __devTriggerNativeCrash();
    }, 4000);
    return () => clearTimeout(t);
  }, []);

  return (
    <AllStakProvider
      apiKey={ALLSTAK_API_KEY}
      host={HOST_FOR_PLATFORM}
      environment="development"
      release="expo-test@1.0.0"
      debug
      captureConsole={{ log: false, info: false, warn: true, error: true }}
      enableHttpTracking
      httpTracking={{
        captureRequestBody: false,
        captureResponseBody: false,
        captureHeaders: false,
        ignoredUrls: [/symbolicate/, /actuator/],
      }}
      fallback={({ error, resetError }) => (
        <View style={styles.fallback}>
          <Text style={styles.fallbackTitle}>Render error caught</Text>
          <Text style={styles.fallbackMessage}>{error.message}</Text>
          <Button title="Try again" onPress={resetError} />
        </View>
      )}
      onError={(error) => {
        // eslint-disable-next-line no-console
        console.log('[sample] onError fired:', error.message);
      }}
    >
      <NavShell />
      <RenderErrorTrigger />
    </AllStakProvider>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: '#fff', padding: 24, paddingBottom: 64 },
  title: { fontSize: 22, fontWeight: '700', marginBottom: 6 },
  help: { fontSize: 13, color: '#666', marginBottom: 16 },
  warn: { fontSize: 12, color: '#a00', marginBottom: 6 },
  section: { marginBottom: 18, gap: 8 },
  sectionLabel: { fontSize: 14, fontWeight: '600', color: '#333' },
  fallback: { flex: 1, backgroundColor: '#fff5f5', alignItems: 'center', justifyContent: 'center', padding: 24 },
  fallbackTitle: { fontSize: 18, fontWeight: '600', color: '#c00', marginBottom: 8 },
  fallbackMessage: { fontSize: 14, color: '#900', marginBottom: 16, textAlign: 'center' },
});
