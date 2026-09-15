# The app has no reflection-based serialization: JSON is parsed by hand with
# org.json, so no model classes need keeping. These rules only cover the
# Compose/Kotlin metadata that R8 warns about when minification is turned on.

-dontwarn org.jetbrains.annotations.**
-dontwarn kotlinx.coroutines.**

# Coroutines' internal service loader and debug probes.
-keepclassmembers class kotlinx.coroutines.** { volatile <fields>; }
-keepclassmembernames class kotlinx.** { volatile <fields>; }

# Never let a stack trace be the thing that leaks the dashboard token: keep
# source-file/line info stripped from release builds.
-renamesourcefileattribute SourceFile
-keepattributes SourceFile,LineNumberTable
