# Publishing

Before creating a public remote, decide:

- GitHub organisation or user owner;
- repository name: `Assistant-Workspace`;
- licence: MIT, copyright AurorasChaos;
- security contact and contribution policy.

Then perform a privacy review of the complete Git history, not only the current tree. This repository currently has no commits and its example content is fictional, which is the safest point at which to publish.

Suggested first release sequence:

1. Confirm the MIT licence and copyright notice.
2. Run `npm test`.
3. Commit the initial repository.
4. Create the public remote under the chosen owner.
5. Push `main` and enable basic branch protection.
6. Open an issue for the configurable base-path milestone.
