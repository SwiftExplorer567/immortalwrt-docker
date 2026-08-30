# Contributing to ImmortalWrt Docker Gateway

We welcome contributions, feature suggestions, and bug reports from the homelab and networking community!

## How to Contribute

1. **Report Bugs:** Open an issue with clear reproduction steps, device architecture (ARM64 / x86_64), and container logs.
2. **Suggest Packages / Features:** Propose packages for `config/packages.txt` by opening a Feature Request issue.
3. **Submit Pull Requests:**
   - Fork the repository.
   - Create a dedicated branch for your change (`git checkout -b feature/my-feature`).
   - Test your changes locally using `./scripts/build.sh`.
   - Commit and push to your fork, then submit a Pull Request against `main`.

## Code Guidelines

- Keep the package set lean and bloat-free.
- Maintain compatibility with both `linux/arm64` and `linux/amd64`.
- Ensure all custom startup scripts in `files/etc/uci-defaults/` are non-destructive and idempotent.
