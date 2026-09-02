# ImmortalWrt Docker Sidecar & Bypass Gateway Master Setup Guide

A complete, end-to-end engineering and deployment guide for setting up **ImmortalWrt on Docker** as a high-performance **Sidecar / Bypass Gateway (Yan Router / 旁路由)** alongside an existing ISP modem/router.

---

## Table of Contents

1. [Fundamental Concept: What is a Sidecar Gateway?](#1-fundamental-concept-what-is-a-sidecar-gateway)
2. [Modem & Router Settings: What to Enable, Disable, and Why](#2-modem--router-settings-what-to-enable-disable-and-why)
3. [Step-by-Step Installation & Deployment](#3-step-by-step-installation--deployment)
   - [Step 1: Host Preparation (Promiscuous Mode)](#step-1-host-preparation-promiscuous-mode)
   - [Step 2: Deploying via Docker Compose](#step-2-deploying-via-docker-compose)
   - [Step 3: Creating the Host-to-Container Bridge (`macvlan-shim`)](#step-3-creating-the-host-to-container-bridge-macvlan-shim)
   - [Step 4: Initial ImmortalWrt LuCI Configuration](#step-4-initial-immortalwrt-luci-configuration)
   - [Step 5: OpenClash & Mihomo Core Optimization](#step-5-openclash--mihomo-core-optimization)
   - [Step 6: Optional Dual-Stack Integration with AdGuard Home / Pi-hole](#step-6-optional-dual-stack-integration-with-adguard-home--pi-hole)
4. [Common Pitfalls & Troubleshooting Matrix](#4-common-pitfalls--troubleshooting-matrix)
5. [Frequently Asked Questions (FAQ)](#5-frequently-asked-questions-faq)

---

## 1. Fundamental Concept: What is a Sidecar Gateway?

In a standard home network, your ISP modem handles everything: Wi-Fi, DHCP, DNS, routing, and NAT.

```
Standard Flow:
Client Device ──────> ISP Modem (192.168.1.1) ──────> Internet
```

In a **Sidecar / Bypass Gateway (Yan Router)** setup:
- The **ISP Modem** remains the physical gateway connected to the Internet (`192.168.1.1`).
- The **ImmortalWrt Docker Container** runs on your server/SBC (e.g. Raspberry Pi, Intel N100) and gets its own distinct IP on the same subnet (`192.168.1.2`).
- Client devices route their outbound traffic and DNS through ImmortalWrt, where **OpenClash (Mihomo Core)** performs transparent proxying, anti-censorship, encryption, and DNS leak prevention, before forwarding packets out through the modem.

```
Sidecar Gateway Flow:
Client Device ──> ImmortalWrt (192.168.1.2) [OpenClash / Mihomo] ──> Modem (192.168.1.1) ──> Internet
```

---

## 2. Modem & Router Settings: What to Enable, Disable, and Why

When configuring your primary ISP modem alongside ImmortalWrt, follow these critical rules:

### A. Modem DHCP Server: Disable (or Restrict)
- **Status:** **DISABLED (Turn Off)** if ImmortalWrt handles DHCP.
- **Why:** If both your modem and ImmortalWrt have DHCP servers enabled on the same local subnet (`192.168.1.0/24`), they will broadcast conflicting IP offers to your devices (Split-Brain DHCP). Devices might randomly receive the modem as their default gateway instead of ImmortalWrt, bypassing your proxy and security rules.
- **Alternative (Selective Routing):** If you prefer your family devices to use standard internet while only your PC/TV uses the gateway, keep the modem's DHCP server enabled and configure the gateway manually (`192.168.1.2`) on specific devices.

### B. DMZ (Demilitarized Zone): Keep Disabled
- **Status:** **DISABLED (Turn Off)**.
- **Why:** 
  1. A bypass gateway handles **outbound** client traffic. Outbound routing does not require DMZ or port forwarding.
  2. Enabling DMZ points **all unsolicited inbound WAN traffic (ports 1–65535)** directly at the container, exposing your LuCI management interface (Port 80/443), Dropbear SSH (Port 22), and internal proxy ports to internet botnets and port scanners.
  3. If your server hosts other services (e.g., Traefik, Portainer, Web servers), pointing DMZ to ImmortalWrt will break external access to those services.

### C. Host IP Reservation
- **Status:** **RESERVE STATIC IP**.
- **Action:** In your modem's LAN settings, assign a static DHCP lease to your Docker Host machine (e.g. `192.168.1.100`) so you never lose administrative access to your server.

---

## 3. Step-by-Step Installation & Deployment

### Step 1: Host Preparation (Promiscuous Mode)

Macvlan requires the physical network interface on the Linux host to accept packets with different MAC addresses:

```bash
# Temporarily enable promiscuous mode on your network interface (e.g. eth0, enp3s0, end0)
sudo ip link set eth0 promisc on
```

To make promiscuous mode persistent across system reboots, create a systemd service:

```bash
sudo tee /etc/systemd/system/promisc-eth0.service > /dev/null <<EOF
[Unit]
Description=Enable Promiscuous Mode on eth0
After=network.target

[Service]
Type=oneshot
ExecStart=/sbin/ip link set eth0 promisc on
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable --now promisc-eth0.service
```

---

### Step 2: Deploying via Docker Compose

Create a directory on your host (e.g. `/opt/immortalwrt`) and create `docker-compose.yml`:

```yaml
services:
  immortalwrt:
    image: hasanjws/immortalwrt-gateway:latest
    container_name: immortalwrt
    restart: unless-stopped
    privileged: true
    cap_add:
      - NET_ADMIN
      - SYS_MODULE
    networks:
      macvlan_lan:
        ipv4_address: 192.168.1.2 # ImmortalWrt Gateway IP
    volumes:
      - /lib/modules:/lib/modules:ro
      - ./data/openclash/config:/etc/openclash/config
      - ./data/config:/etc/config
      - ./data/shadow:/etc/shadow
      - ./data/dropbear:/etc/dropbear

networks:
  macvlan_lan:
    driver: macvlan
    driver_opts:
      parent: eth0 # Replace with your physical host interface
    ipam:
      config:
        - subnet: 192.168.1.0/24      # Match your home network subnet
          gateway: 192.168.1.1        # Match your modem IP
          ip_range: 192.168.1.2/32    # Container static IP range
```

Start the container:
```bash
docker compose up -d
```

---

### Step 3: Creating the Host-to-Container Bridge (`macvlan-shim`)

Due to Linux kernel security constraints, a host cannot communicate directly with child macvlan interfaces on the same physical link. If your host server needs to communicate with or route through the ImmortalWrt container, create a `macvlan-shim` on the host:

```bash
sudo ip link add macvlan-shim link eth0 type macvlan mode bridge
sudo ip addr add 192.168.1.250/24 dev macvlan-shim
sudo ip link set macvlan-shim up
sudo ip route add 192.168.1.2 dev macvlan-shim
```

To make this bridge persistent across reboots, add a systemd service:

```bash
sudo tee /etc/systemd/system/macvlan-shim.service > /dev/null <<EOF
[Unit]
Description=Macvlan Shim for ImmortalWrt Docker
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/bin/sh -c "ip link add macvlan-shim link eth0 type macvlan mode bridge && ip addr add 192.168.1.250/24 dev macvlan-shim && ip link set macvlan-shim up && ip route add 192.168.1.2 dev macvlan-shim"
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl enable --now macvlan-shim.service
```

---

### Step 4: Initial ImmortalWrt LuCI Configuration

1. Open your browser and navigate to: `http://192.168.1.2`
2. **Username:** `root` | **Password:** *(blank by default)*
3. **Network Interface Settings (`Network` -> `Interfaces` -> `LAN` -> `Edit`):**
   - **IPv4 Address:** `192.168.1.2`
   - **IPv4 Netmask:** `255.255.255.0`
   - **IPv4 Gateway:** `192.168.1.1` (Your ISP Modem IP)
   - **Custom DNS Servers:** `192.168.1.1`, `1.1.1.1`
4. **Firewall Settings (`Network` -> `Firewall`):**
   - **General Settings:** Ensure `Forward` is set to `ACCEPT`.
   - **Zones (LAN):** Enable `Masquerading` (`masq=1`) and set `Forward` to `ACCEPT`.
5. **DHCP Server Settings (`Network` -> `Interfaces` -> `LAN` -> `DHCP Server`):**
   - If using ImmortalWrt as primary DHCP: Uncheck `Ignore interface`.
   - Under `Advanced Settings` -> `DHCP-Options`:
     - `3,192.168.1.2` *(Tells clients to use ImmortalWrt as Default Gateway)*
     - `6,192.168.1.2` *(Tells clients to use ImmortalWrt for DNS)*

---

### Step 5: OpenClash & Mihomo Core Optimization

1. Navigate to **Services** -> **OpenClash**.
2. **Config Subscription / Import:** Paste your Clash subscription URL or upload your `.yaml` configuration under `Config Manage`.
3. **Recommended Operation Mode (`Plugin Settings` -> `Operation Mode`):**
   - Choose **Fake-IP TUN Mode (`enhanced-mode: fake-ip`)**.
   - Fake-IP TUN captures all DNS requests locally, prevents DNS poisoning, and enables seamless domain-based geo-routing.
4. **Block QUIC Protocol (UDP 443):**
   - In your Clash configuration rules, reject UDP 443 to force streaming apps (YouTube, Twitch, Discord) onto TCP HTTP/2 fallback. This prevents UDP stalling over proxy nodes:
     ```yaml
     rules:
       - AND,((DST-PORT,443),(NETWORK,UDP)),REJECT
     ```
5. Click **Apply Settings** and start OpenClash.

---

### Step 6: Optional Dual-Stack Integration with AdGuard Home / Pi-hole

If you want network-wide ad blocking combined with OpenClash bypass routing:

1. Run **AdGuard Home** in Docker on your host (e.g. at IP `192.168.1.53` or host port 53).
2. Configure **DHCP Option 6** in ImmortalWrt:
   - `6,192.168.1.53,192.168.1.2` *(Primary DNS: AdGuard Home, Fallback: ImmortalWrt)*
3. In **AdGuard Home Upstream Settings**:
   - For local hostname resolution, add: `[/lan/]192.168.1.2:53`
   - For internet queries, use encrypted DoH upstreams:
     - `https://dns.quad9.net/dns-query`
     - `https://dns.cloudflare.com/dns-query`
4. **Result:** Client DNS queries are sanitized by AdGuard Home, while all outbound TCP/UDP traffic is transparently routed and accelerated through ImmortalWrt.

---

### Step 7: SQM Bufferbloat Elimination & Real-time Bandwidth Monitoring

1. **SQM (Smart Queue Management) with CAKE:**
   - In LuCI, navigate to **Network** -> **SQM QoS**.
   - **Interface:** Select `eth0`.
   - **Download / Upload Speeds:** Set to 90–95% of your measured physical line speeds (e.g. 62000 kbit/s down, 13000 kbit/s up for a 70/15 line).
   - **Queue Discipline:** Select `cake` and script `piece_of_cake.qos`.
   - **Benefit:** Completely eliminates loaded ping spikes and bufferbloat under heavy downloads/uploads.

2. **Per-Device Speed Limits (EQOS):**
   - Navigate to **Network** -> **EQOS**.
   - View real-time per-host download/upload speeds or set bandwidth caps for specific local IP addresses.

3. **Real-time Performance Dashboards:**
   - **Bandwidth Accounting:** **Services** -> **Bandwidth Monitor** (`nlbwmon`).
   - **Sub-second Metrics:** **Services** -> **Netdata**.
   - **Historical RRD Graphs:** **Statistics** -> **Graphs** (`collectd`).

---

## 4. Common Pitfalls & Troubleshooting Matrix

| Symptom / Error | Root Cause | Verified Solution |
|---|---|---|
| **Clients have no internet when gateway is set to 192.168.1.2** | Firewall masquerading disabled or missing default route. | In LuCI `Network` -> `Firewall`, ensure `lan` zone has `Masquerading: Enabled` and `Forward: ACCEPT`. Verify `192.168.1.1` is set as gateway in `Network` -> `Interfaces` -> `LAN`. |
| **Docker Host cannot communicate with ImmortalWrt** | Linux kernel isolation prevents parent interface from talking to child macvlan. | Run the `macvlan-shim` setup script in Step 3. |
| **Certain devices randomly lose connection or bypass proxy** | Dual DHCP servers active (ISP Modem + ImmortalWrt). | Disable the DHCP server on the ISP modem completely so only ImmortalWrt issues leases. |
| **OpenClash shows Core Not Found error** | Custom image missing pre-compiled binary. | This repository (`hasanjws/immortalwrt-gateway`) pre-embeds the latest Mihomo binary in `/etc/openclash/core/`. No manual download is required. |
| **Discord app hangs on "Connecting..." on mobile** | Cloudflare WARP IP flagged by Discord WAF captcha, or `url-test` selecting WARP over residential VPN. | In Clash config, use `fallback` group with a clean VPN (e.g. ProtonVPN) as primary. Ensure all Discord subdomains (`*.discord.gg`, `*.discordapp.net`) and IP CIDR blocks (`162.159.0.0/16`, `66.22.192.0/18`) are routed to the proxy group. |
| **EQOS bandwidth limit not taking effect in Docker** | EQOS script hardcoded to look for `br-lan`. | Ensure `/usr/sbin/eqos` uses `dev=$(uci -q get network.lan.device || echo eth0)`. Pre-configured automatically in this image. |
| **DNS Leaks on Mobile (iOS / Android)** | IPv6 DNS bypass or fallback to cellular DNS. | In ImmortalWrt, disable IPv6 DNS advertising (`IPv6 assignment: disabled` or uncheck IPv6 DHCP on LAN), and enforce Fake-IP TUN mode. |
| **Video streaming buffers or stalls over proxies** | QUIC protocol (UDP 443) connection drops. | Add rule `AND,((DST-PORT,443),(NETWORK,UDP)),REJECT` to force standard HTTP/2 TCP fallback. |

---

## 5. Frequently Asked Questions (FAQ)

#### Q1: Can I use this image without changing my main modem's DHCP server?
**Yes.** Keep your modem's DHCP server on, and on devices where you want proxy/adblock capabilities (e.g. Apple TV, Gaming PC), go to network settings and manually set:
- **IP:** `192.168.1.X`
- **Subnet Mask:** `255.255.255.0`
- **Default Gateway:** `192.168.1.2`
- **DNS Server:** `192.168.1.2`

#### Q2: Does running ImmortalWrt in Docker have performance penalties compared to bare metal?
**No.** Docker utilizes native Linux network namespaces and kernel cgroups with negligible overhead (<1% CPU difference). Throughput on ARM64 (Raspberry Pi 4/5) and x86_64 (Intel N100) easily saturates Gigabit LAN speeds.

#### Q3: How do I persist my configurations, root password, and SSH keys?
Ensure the volume mappings `./data/openclash/config:/etc/openclash/config`, `./data/config:/etc/config`, `./data/shadow:/etc/shadow`, and `./data/dropbear:/etc/dropbear` are specified in your `docker-compose.yml`. All configurations, LuCI passwords, and SSH keys will survive container upgrades and reboots.
