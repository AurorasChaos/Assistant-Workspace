# Personal account for this repository only

The machine's global Git identity and active GitHub CLI account belong to the work account. Keep them unchanged. Assistant Workspace should use repository-local identity plus a personal SSH host alias.

## 1. Create a dedicated personal SSH key

Choose your personal GitHub email and a key filename that does not overlap the work key:

```bash
ssh-keygen -t ed25519 -C "PERSONAL_EMAIL" -f ~/.ssh/id_ed25519_github_personal
```

Add `~/.ssh/id_ed25519_github_personal.pub` to **personal GitHub → Settings → SSH and GPG keys**. Never upload or share the private file.

## 2. Add a host alias

Add this block to `~/.ssh/config` without changing the existing work entry:

```sshconfig
Host github-personal
  HostName github.com
  User git
  IdentityFile ~/.ssh/id_ed25519_github_personal
  IdentitiesOnly yes
```

Test it:

```bash
ssh -T git@github-personal
```

GitHub normally responds that authentication succeeded but shell access is unavailable.

## 3. Set identity only in Assistant Workspace

Run inside this repository, without `--global`:

```bash
git config user.name "<account>"
git config user.email "<id>+<account>@users.noreply.github.com"
git remote add origin git@github-personal:<account>/Assistant-Workspace.git
```

The repository-local values override the global work identity only here. Ready repositories continue using the global work identity and existing credentials.

## 4. Optional GitHub CLI access

GitHub CLI can store both accounts, but its active account is host-wide rather than repository-local. Add the personal login, then return the active account to work:

```bash
gh auth login --hostname github.com --web --git-protocol ssh --skip-ssh-key
gh auth switch --hostname github.com --user PlayerReadyPortsmouth
```

For an occasional personal CLI command without changing the active account:

```bash
GH_TOKEN="$(gh auth token --hostname github.com --user <account>)" \
  gh repo view <account>/Assistant-Workspace
```

Do not print, persist or commit the token. Ordinary `git fetch`, `pull` and `push` use the repository's `github-personal` SSH remote and do not depend on the active `gh` account.
