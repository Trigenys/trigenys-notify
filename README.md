# AppFactory Landing Template

Reusable landing page template for AppFactory, designed for automated generation, validation and deployment of high-quality websites across industries.

## Current milestone

**M0 — Template Foundation**

The template is intentionally manifest-driven. AppFactory should be able to create a repository from this template and change the business content and design direction primarily through `appfactory.json`.

```text
appfactory.json
      ↓
React renderer
      ↓
Design recipe
      ↓
Production build
```

## Stack

- React 19
- TypeScript
- Vite
- Tailwind CSS 4
- GitHub Actions

## Local development

```bash
npm install
npm run dev
```

Validate a production build with:

```bash
npm run typecheck
npm run build
```

## Manifest

`appfactory.json` currently controls:

- project identity;
- design recipe (`corporate`, `luxury`, `saas`);
- animation intent;
- hero content and CTAs;
- feature content;
- final CTA.

The contract is documented by `appfactory.schema.json`.

## Automation boundary

This repository is a template, not the AppFactory orchestrator. The orchestrator will create new repositories from this template, write project-specific manifests, trigger CI/CD and collect deployment status.
