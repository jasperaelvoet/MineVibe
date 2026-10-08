// @ts-check
import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import starlightLinksValidator from 'starlight-links-validator';

const repo = 'https://github.com/jasperaelvoet/MineVibe';

// Served from GitHub Pages at https://jasperaelvoet.github.io/MineVibe/.
// Internal links in content must include the base (`/MineVibe/...`): the links validator
// checks every one of them at build time and fails the build on a broken link or anchor.
export default defineConfig({
  site: 'https://jasperaelvoet.github.io',
  base: '/MineVibe',
  integrations: [
    starlight({
      title: 'MineVibe',
      description:
        'A hardcore Minecraft world where Claude Code agents live, survive and work at real computers. Pre-alpha.',
      social: [{ icon: 'github', label: 'GitHub', href: repo }],
      editLink: { baseUrl: `${repo}/edit/main/apps/docs/` },
      customCss: ['./src/styles/custom.css'],
      plugins: [starlightLinksValidator()],
      sidebar: [
        {
          label: 'Start',
          items: [
            { label: 'Welcome', slug: 'index' },
            { label: 'Getting started', slug: 'getting-started' },
          ],
        },
        {
          label: 'Play',
          items: [{ label: 'Playing MineVibe', slug: 'playing' }],
        },
        {
          label: 'PCs',
          items: [{ label: 'PCs and the Vault', slug: 'pcs-and-vault' }],
        },
        {
          label: 'Build',
          items: [
            { label: 'Architecture', slug: 'architecture' },
            { label: 'Development', slug: 'development' },
          ],
        },
        {
          label: 'Reference',
          items: [
            { label: 'Wire protocol', slug: 'protocol' },
            { label: 'Troubleshooting', slug: 'troubleshooting' },
          ],
        },
        {
          label: 'About',
          items: [{ label: 'Legal and licensing', slug: 'legal' }],
        },
      ],
    }),
  ],
});
