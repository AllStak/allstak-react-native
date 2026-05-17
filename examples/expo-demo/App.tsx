import React from 'react';
import { View, Text, Button, StyleSheet, Alert, ScrollView } from 'react-native';
import { AllStakProvider, AllStak } from '@allstak/react-native';

const API_KEY = process.env.ALLSTAK_API_KEY || 'ask_dev_demo_key';
const HOST = process.env.ALLSTAK_HOST || 'https://api.allstak.sa';

function DemoScreen() {
  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.title}>AllStak React Native Demo</Text>
      <Text style={styles.subtitle}>Tap a button to test each SDK feature</Text>

      <View style={styles.buttonRow}>
        <Button
          title="Trigger JS Error"
          onPress={() => {
            // Caught by AllStakProvider's built-in ErrorBoundary
            // and sent to /ingest/v1/errors automatically.
            throw new Error('Demo JS error from button press');
          }}
        />
      </View>

      <View style={styles.buttonRow}>
        <Button
          title="Trigger Promise Rejection"
          onPress={() => {
            // Unhandled rejection — AllStak's rejection tracking hook
            // captures this automatically.
            Promise.reject(new Error('Demo unhandled promise rejection'));
          }}
        />
      </View>

      <View style={styles.buttonRow}>
        <Button
          title="Manual Capture"
          onPress={() => {
            // Explicitly capture an exception with extra metadata.
            const err = new Error('Manually captured error');
            AllStak.captureException(err, {
              component: 'DemoScreen',
              action: 'manual-capture-button',
            });
            Alert.alert('Captured', 'Error sent to AllStak via captureException');
          }}
        />
      </View>

      <View style={styles.buttonRow}>
        <Button
          title="Add Breadcrumb"
          onPress={() => {
            // Breadcrumbs attach context to the next captured error.
            AllStak.addBreadcrumb({
              type: 'ui',
              level: 'info',
              message: 'User tapped Add Breadcrumb button',
              data: { screen: 'DemoScreen', timestamp: Date.now() },
            });
            Alert.alert('Breadcrumb Added', 'Will attach to the next error capture');
          }}
        />
      </View>

      <View style={styles.buttonRow}>
        <Button
          title="Test Network Request"
          onPress={async () => {
            // When enableHttpTracking is on, this fetch is auto-instrumented.
            // AllStak records method, URL, status, duration.
            try {
              const res = await fetch('https://httpbin.org/get');
              const data = await res.json();
              Alert.alert('Network OK', `Status: ${res.status}, URL: ${data.url}`);
            } catch (err) {
              AllStak.captureException(err as Error, {
                action: 'test-network-request',
              });
              Alert.alert('Network Error', (err as Error).message);
            }
          }}
        />
      </View>
    </ScrollView>
  );
}

export default function App() {
  return (
    <AllStakProvider
      apiKey={API_KEY}
      host={HOST}
      environment="development"
      release="1.0.0"
      enableHttpTracking
      debug
      fallback={
        <View style={styles.errorContainer}>
          <Text style={styles.errorText}>Something went wrong.</Text>
          <Text style={styles.errorSubtext}>The error has been reported to AllStak.</Text>
        </View>
      }
    >
      <DemoScreen />
    </AllStakProvider>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
    backgroundColor: '#f8f9fa',
  },
  title: {
    fontSize: 24,
    fontWeight: '700',
    marginBottom: 8,
    color: '#1a1a2e',
  },
  subtitle: {
    fontSize: 14,
    color: '#6c757d',
    marginBottom: 32,
  },
  buttonRow: {
    width: '100%',
    marginBottom: 16,
  },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  errorText: {
    fontSize: 20,
    fontWeight: '600',
    color: '#dc3545',
    marginBottom: 8,
  },
  errorSubtext: {
    fontSize: 14,
    color: '#6c757d',
  },
});
