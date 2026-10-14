// One place for button styles. Use on <button> or <Link>/<a>: className={button('primary')}.
// To restyle every button on the site, edit these strings.

type Variant = 'primary' | 'secondary' | 'ghost';
type Size = 'sm' | 'md';

const base = 'inline-flex items-center justify-center gap-2 rounded-xl font-semibold transition disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-400';

const variants: Record<Variant, string> = {
  // Polished brass: a lighter top edge and a darker bottom one, so it reads as metal rather than a flat fill.
  primary: 'bg-gradient-to-b from-accent-300 to-accent-500 text-ink-950 shadow-[inset_0_1px_0_rgb(255_250_235/0.55),inset_0_-1px_0_rgb(0_0_0/0.25),0_8px_24px_-12px_rgb(207_171_102/0.6)] hover:from-accent-200 hover:to-accent-400 active:to-accent-600',
  secondary: 'border border-line-strong bg-panel/70 text-ink-100 hover:border-ink-500 hover:bg-panel-raised',
  ghost: 'text-ink-300 hover:bg-white/5 hover:text-white',
};

const sizes: Record<Size, string> = {
  sm: 'px-3.5 py-1.5 text-[13.5px]',
  md: 'px-5 py-2.5 text-[15px]',
};

export const button = (variant: Variant = 'primary', size: Size = 'md', extra = '') => `${base} ${variants[variant]} ${sizes[size]} ${extra}`.trim();
