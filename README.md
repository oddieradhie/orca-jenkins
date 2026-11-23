# Jenkins for Orca

Unofficial community plugin to monitor Jenkins CI/CD jobs, build queues, console logs, and trigger parameterized builds directly from Orca.

## Features

- **Status Bar Counter**: Live summary of running, failed, unstable, and passing builds with one-click refresh.
- **Jobs & Folders**: Recursive job discovery across Jenkins folders and multibranch pipelines, with status filters (`All`, `Building`, `Failed`, `Pass`, `★` favorites) and search.
- **Build Queue**: View queued builds, wait reasons, stuck/blocked states, and cancel queued items.
- **Job Detail & Console Log**: Inspect recent build history, trigger causes, duration, and view console output directly in the sidebar.
- **Build Triggers**: Run `Build Now` or `Build with Parameters` (supporting String, Boolean, Choice, Password, and Text parameters) and stop active builds.
- **Notifications**: Desktop notifications when monitored builds finish or fail.
- **Secure Credentials**: Jenkins URL, username, and API token are stored using Orca's encrypted `secrets:own` storage.

## Installation

### From Orca UI
1. Open **Settings → Plugins → Add plugin → From a Git URL…**
2. Enter:
   ```text
   https://github.com/oddieradhie/orca-jenkins
   ```

### From CLI
```bash
orca plugin install github:oddieradhie/orca-jenkins
```

## Setup

1. Open the **Jenkins** panel in Orca's right sidebar.
2. Enter your **Jenkins URL** (e.g. `https://jenkins.example.com`), **Username**, and **API Token**.
3. Optionally configure **Poll Interval (seconds)** (minimum 10s) and a **View Filter**.
4. Click **Save & Connect**.

> **Disclaimer**: This is an unofficial community plugin and is not affiliated with or endorsed by the Jenkins project or the Continuous Delivery Foundation.
