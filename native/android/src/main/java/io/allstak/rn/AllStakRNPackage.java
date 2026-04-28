package io.allstak.rn;

import androidx.annotation.NonNull;

import com.facebook.react.ReactPackage;
import com.facebook.react.bridge.NativeModule;
import com.facebook.react.bridge.ReactApplicationContext;
import com.facebook.react.uimanager.ViewManager;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * AllStak RN package — registered via React Native autolinking
 * (see ../../../../../../../react-native.config.js at the package root).
 *
 * Adds {@link AllStakRNModule} to the React bridge so JS can call
 * {@code NativeModules.AllStakNative.install(release)} and
 * {@code drainPendingCrash()}.
 */
public class AllStakRNPackage implements ReactPackage {
  @Override
  @NonNull
  public List<NativeModule> createNativeModules(@NonNull ReactApplicationContext reactContext) {
    List<NativeModule> modules = new ArrayList<>();
    modules.add(new AllStakRNModule(reactContext));
    return modules;
  }

  @Override
  @NonNull
  public List<ViewManager> createViewManagers(@NonNull ReactApplicationContext reactContext) {
    return Collections.emptyList();
  }
}
