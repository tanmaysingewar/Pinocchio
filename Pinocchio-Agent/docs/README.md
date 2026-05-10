# Pinocchio Docs

This folder explains how Pinocchio works end to end and documents all of the major features of the Pinocchio agent.

Start here:

- [How It Works](./how-it-works.md)
- [Feature Overview](./features.md)

## What Pinocchio Is

Pinocchio is a TypeScript agent SDK with two core ideas:

- a simple Anthropic-style `query()` workflow
- a fully editable local tool system under `.agents/`

The goal is transparency. Every tool, skill, command, agent, and plugin is meant to be inspectable and replaceable by the user. Pinocchio does not ship a hidden default tool pack.

For detailed coverage of what the agent can do in a project, see `features.md`.
