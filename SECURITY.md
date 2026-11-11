# Security

ctjs is an experimental compiler, not a sandbox.

Compile-time APIs receive the host's `options.api` object and can execute
arbitrary JavaScript during the build.  Do not compile untrusted source with
privileged compile-time APIs.

If you find a vulnerability in the compiler, CLI, or generated helper code,
please open a private security advisory on the GitHub repository rather than a
public issue.  Include a minimal reproducer and the affected version/commit.
