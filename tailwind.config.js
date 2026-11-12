// Tailwind with the site's own tokens: the colours are the CSS variables of src/style.css (so they follow light
// and dark), and the type scale is the sizes the pages use, in px, without Tailwind's paired line-heights (the
// line-height is the body's 1.45 everywhere).
export default {
  content: ['./index.html', './src/**/*.{vue,js}'],
  theme: {
    colors: {
      transparent: 'transparent',
      inherit: 'inherit',
      white: '#fff',
      bg: 'var(--bg)',
      panel: 'var(--panel)',
      ink: 'var(--ink)',
      muted: 'var(--muted)',
      line: 'var(--line)',
      accent: 'var(--accent)',
      'accent-soft': 'var(--accent-soft)',
      beat: 'var(--beat)',
      loop: 'var(--loop)',
      'loop-line': 'var(--loop-line)',
      chord: 'var(--chord)',
      'warn-bg': 'var(--warn-bg)',
      'warn-ink': 'var(--warn-ink)',
      ok: '#16a34a'
    },
    fontSize: { 11: '11px', 12: '12px', 13: '13px', 14: '14px', 15: '15px', 17: '17px', 20: '20px', 30: '30px' },
    fontFamily: {
      sans: ['-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'Roboto', 'sans-serif'],
      mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace']
    }
  }
};
