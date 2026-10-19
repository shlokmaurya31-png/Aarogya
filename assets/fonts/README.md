# Fonts for the synthetic report renderer

Used only by `src/lib/documents/fixtures/render.ts`, which draws the synthetic
evaluation reports (no real documents) in their own scripts for the manual
real-provider evaluation. Never served to users. Each font is under the SIL
Open Font License 1.1; the licence texts are in `licenses/`.

| File | Family | Scripts | Source |
|---|---|---|---|
| NotoSans-Regular.ttf | Noto Sans | Latin | notofonts/latin-greek-cyrillic |
| NotoSansDevanagari-Regular.ttf | Noto Sans Devanagari | Devanagari (Hindi, Marathi) | notofonts/devanagari |
| NotoSansBengali-Regular.ttf | Noto Sans Bengali | Bengali | notofonts/bengali |
| NotoSansTamil-Regular.ttf | Noto Sans Tamil | Tamil | notofonts/tamil |
| NotoSansTelugu-Regular.ttf | Noto Sans Telugu | Telugu | notofonts/telugu |
| NotoSansKannada-Regular.ttf | Noto Sans Kannada | Kannada | notofonts/kannada |
| NotoSansMalayalam-Regular.ttf | Noto Sans Malayalam | Malayalam | notofonts/malayalam |
| NotoSansGujarati-Regular.ttf | Noto Sans Gujarati | Gujarati | notofonts/gujarati |
| NotoSansOriya-Regular.ttf | Noto Sans Oriya | Odia | notofonts/oriya |
| NotoNastaliqUrdu-Regular.ttf | Noto Nastaliq Urdu | Urdu (Nastaliq) | notofonts/nastaliq |
| Kalam-Regular.ttf | Kalam | handwriting: Latin, Devanagari | google/fonts ofl/kalam |
| Gurajada-Regular.ttf | Gurajada | handwriting: Telugu | google/fonts ofl/gurajada |
| Kavivanar-Regular.ttf | Kavivanar | handwriting: Tamil | google/fonts ofl/kavivanar |
| Atma-Regular.ttf | Atma | handwriting: Bengali | google/fonts ofl/atma |

SHA-256 of each file is listed below. Noto files are the hinted static builds from notofonts.github.io (2026-10-18).
The renderer points Pango at a private fontconfig that lists only this
directory, so no system font is ever used.

```
3ddd9e02b4b6077b25c07f5d1f4411c9071e5030a4124d77dcd5a04fa292b921  Atma-Regular.ttf
353c1289a6f4ba743154c870418272cf68e0f63c0c38598ed33cba814d3178e8  Gurajada-Regular.ttf
57cecb63d4608019371954274ae1d8c397764debd5b19d4a33c1efa4dc923c0b  Kalam-Regular.ttf
ab373a218ee8464fee6ed14ee864d5a6c5146ca0458f0a61678a1889fe44b710  Kavivanar-Regular.ttf
4d05b6821862ca1f3c80c47c80a352b47dd349ab73814f60e377eea311e0e42c  NotoNastaliqUrdu-Regular.ttf
478c558ea716033cd60c03438f628dfa75694dcf6b5f6d505a2f05fd2b4f3823  NotoSans-Regular.ttf
b55c62ee531e3214da6c0701daecea89a52ba42db7d8206b92e6b51f397a3193  NotoSansBengali-Regular.ttf
4e3c66638958c3e2ab5d37f47a8deb89fffeb7be9985c665a519bbc7ba762313  NotoSansDevanagari-Regular.ttf
9b5a7aaeeb649a2e75a49d8b006a1f87db1b61c0df3b001609f4e0725d88dbf6  NotoSansGujarati-Regular.ttf
9ad74dc64838c6855b96f671fc08e425a58921b9d0c71712ea79c328a27e6e38  NotoSansKannada-Regular.ttf
c08de7fa8d032a5d6a4d120fb82c78cec60b362a4e73fa26360d89759ff2a7f9  NotoSansMalayalam-Regular.ttf
a16645d056017927406546aa78e4ce15e782fd8783467267b75450453d007415  NotoSansOriya-Regular.ttf
3c0a186feb3c63c7f6d63e1511dcdc144e745ae09b98e217c83f3e317974f6f9  NotoSansTamil-Regular.ttf
b274780b69d1d23fe84b55e809a152cb2ac5306d33864b1f87622f6971871aae  NotoSansTelugu-Regular.ttf
```
