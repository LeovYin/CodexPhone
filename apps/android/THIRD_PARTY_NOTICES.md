# Android third-party notices

CodexPhone source is MIT licensed. Original copyrights and licenses of bundled libraries and transitive dependencies remain applicable. No Codex or Tailscale executable is bundled in the Android APK.

| Project | License | Source |
| --- | --- | --- |
| AndroidX / Jetpack Compose / Material | Apache-2.0 | https://android.googlesource.com/platform/frameworks/support |
| Kotlin / kotlinx.coroutines / kotlinx.serialization | Apache-2.0 | https://github.com/JetBrains/kotlin |
| OkHttp / Okio | Apache-2.0 | https://github.com/square/okhttp |
| Coil | Apache-2.0 | https://github.com/coil-kt/coil |
| Markwon | Apache-2.0 | https://github.com/noties/Markwon |
| CommonMark Java | BSD-2-Clause | https://github.com/commonmark/commonmark-java |
| AndroidSVG | Apache-2.0 | https://github.com/BigBadaboom/androidsvg |
| Mermaid (bundled local diagram renderer) | MIT; dependencies retain their licenses | https://github.com/mermaid-js/mermaid |
| JetBrains annotations | Apache-2.0 | https://github.com/JetBrains/java-annotations |
| Gradle Wrapper (source only) | Apache-2.0 | https://github.com/gradle/gradle |

Complete license texts and embedded dependency notices are in THIRD_PARTY_LICENSES.txt in source and release attachments. Test-only JUnit, MockWebServer and Android test libraries are not app runtime dependencies.

Mermaid 11.12.2 is bundled in app assets, including its license and dependency notices. Run `node scripts/Sync-Diagrams.mjs` from the repository root after changing the locked Mermaid version; this regenerates the local renderer and notices together. The app does not fetch a renderer from a CDN.
