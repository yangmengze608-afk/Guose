# Security

PRIVATE_REPORTING_CHANNEL = CONFIGURED。安全问题可私密发送到 `yangmengze608@gmail.com`。
该邮箱是当前维护者已公开在 GitHub profile 上的真实联系邮箱；邮件内容本身为私密沟通。

Guose modifies code only in an explicitly approved isolated **owned-demo** copy.
Analysis and legacy dry-run patches never apply to the target. The executor is
not a general executable sandbox or third-party runtime backend.

Security reports include scope escape, unintended writes, protected-region
mutation, unsafe undo, arbitrary execution and secret exposure. Never post
credentials, private source or exploit details in issues.

For sensitive security reports, email **yangmengze608@gmail.com** or use GitHub Private Vulnerability Reporting. Do not post credentials, private source, or exploit details in public issues. Both private reporting routes are enabled for the public repository.

No claim of zero vulnerabilities, hostile concurrent-filesystem confinement,
complete secret detection or accessibility certification is made. Undo requires
live process authority and unchanged post-execution source bytes; later edits
cause a stop. Killing the host may retain a temporary copy. Best-effort filtering
does not prove secret-free output. [Security model](docs/SECURITY_MODEL.md)
