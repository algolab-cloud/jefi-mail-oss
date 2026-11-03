# Third-Party Notices

## GPUIX native renderer

Jefi includes a locally built derivative of [GPUIX](https://github.com/remorses/gpuix)
0.8.0 at commit `8d3ec094387152558d05a5b37de3cfbfca5d2d0a`, with its Zed/GPUI
submodule pinned at `81c99f816b4a5f69d3c014774068034c24d1d7af`. Jefi's source patch adds
per-link hover and keyboard focus events to the existing native Markdown renderer. GPUIX and
GPUI are licensed under Apache License 2.0; the license is included at
`docs/licenses/gpuix-APACHE-2.0.txt`. GPUIX's renderer also contains MIT-licensed portions
ported from Comet (Copyright (c) 2026 Wing), as recorded in GPUIX's upstream
`THIRD_PARTY_NOTICES.md`; Comet's MIT license is included at
`docs/licenses/comet-MIT.txt`.

## Phishing.Database data

Jefi can download active phishing domain and URL data from
[Phishing.Database](https://github.com/Phishing-Database/Phishing.Database).
That data is made available under the following license:

MIT License

Copyright (c) 2018-2025 Mitchell Krog - github.com/mitchellkrogza

Copyright (c) 2018-2025 Nissar Chababy - github.com/funilrys

Copyright (c) 2018-2025 Phishing.Database Contributors - github.com/Phishing-Database

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Zed crates under the GPL

GPUIX's pinned Zed/GPUI submodule includes the `zlog` and `ztracing` crates, which are licensed
under GPL-3.0-or-later; their licence is the same as Jefi Mail's (see `LICENSE`).
