# U8g2 Font Generator

Generate U8g2-compatible font source files from fonts installed on the local machine.

## Features

- Lists locally installed fonts through the child-tool backend.
- Serves selected font files through a token-protected local endpoint for browser canvas rasterization.
- Supports font size selection and built-in character sets for 1000, 2000, 3000, 5000, 7000, and 9000 characters.
- Loads common character data from `assets/1000.txt`, `assets/2000.txt`, `assets/3000.txt`, `assets/5000.txt`, `assets/7000.txt`, and `assets/9000.txt`; each higher tier stores only the extra characters beyond the previous tier.
- Supports custom character input.
- Generates U8g2 RLE font data, a matching header, a BDF export, metadata, and a README in one ZIP package.

## Commands

```powershell
npm install --prefix u8g2-font-generator
node u8g2-font-generator/index.js --help
node u8g2-font-generator/index.js status
node u8g2-font-generator/index.js fonts
node u8g2-font-generator/index.js serve --host 127.0.0.1 --port 0
```

## Development

```powershell
npm run dev -- u8g2-font-generator --open
npm run build -- u8g2-font-generator
```

Common character presets are cumulative. For example, selecting 2000 characters loads `assets/1000.txt` plus `assets/2000.txt`; selecting 5000 loads `1000.txt`, `2000.txt`, `3000.txt`, and `5000.txt`.

The generated package contains:

- `<symbol>.c`: U8g2 font array.
- `<symbol>.h`: external declaration.
- `<symbol>.bdf`: intermediate bitmap font data.
- `metadata.json`: generation settings and size data.
- `README.md`: usage snippet.
