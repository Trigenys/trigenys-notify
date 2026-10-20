# Agent instructions

This repository follows the Trigenys RAIDER engineering standard.

Changes must remain reusable, configuration-driven, provider-agnostic where practical, idempotent when remote or durable state is reconciled, non-regressive, least-privilege, testable and adoptable by existing consumers.

Before risky changes, review `docs/engineering/lessons-learned.md`. Significant failures or near misses require a root-cause note and a proportionate prevention mechanism.

Keep transport, persistence and provider adapters behind explicit boundaries so the domain core remains testable without infrastructure.
