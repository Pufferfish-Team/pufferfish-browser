# Pufferfish update signing certificates

`dep1.der` and `dep2.der` replace Firefox's copies. Pufferfish's update
channel ("pufferfish") makes the updater trust these two certificates (see
`moz.build` in this folder), so it only installs update packages (`.mar`
files) signed with the Pufferfish update key:

- `dep1.der`: primary key, used to sign every release.
- `dep2.der`: backup key, kept for replacing the primary if it is ever lost
  or compromised.

These are public certificates. The private keys are kept outside the
repository, in `configs/keys/update-signing/`, which git ignores.
