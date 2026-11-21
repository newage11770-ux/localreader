"""Local Wi-Fi IPv4 detection and QR code generation for LocalReader."""

from __future__ import annotations

import base64
import io
import ipaddress
import os
import re
import socket
import subprocess
from typing import Any

import qrcode
from qrcode.image.svg import SvgPathImage


VIRTUAL_ADAPTER_HINTS = (
    "vethernet",
    "wsl",
    "hyper-v",
    "virtualbox",
    "vmware",
    "docker",
    "loopback",
    "bluetooth",
    "tunnel",
    "tailscale",
    "zerotier",
    "hamachi",
    "wireguard",
    "vpn",
    "tap-",
    "tun",
)

PREFERRED_ADAPTER_HINTS = (
    "wi-fi",
    "wifi",
    "wireless",
    "wlan",
    "ethernet",
)


def _is_usable_lan_ipv4(ip_str: str) -> bool:
    try:
        ip = ipaddress.IPv4Address(ip_str)
    except ValueError:
        return False
    return not (ip.is_loopback or ip.is_link_local or ip.is_multicast or ip.is_unspecified)


def _get_default_route_ip() -> str | None:
    """Ask OS routing table which local IPv4 reaches the default gateway (no packets sent)."""
    for probe in ("8.8.8.8", "1.1.1.1", "192.168.1.1", "10.0.0.1"):
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            sock.settimeout(0.3)
            sock.connect((probe, 80))
            candidate = sock.getsockname()[0]
            if _is_usable_lan_ipv4(candidate):
                return candidate
        except OSError:
            continue
        finally:
            sock.close()
    return None


def _parse_windows_ipconfig() -> list[tuple[int, str, str]]:
    """Return scored (priority, ip, adapter_name) tuples from Windows ipconfig."""
    results: list[tuple[int, str, str]] = []
    if os.name != "nt":
        return results
    try:
        proc = subprocess.run(
            ["ipconfig"],
            capture_output=True,
            text=True,
            timeout=2.5,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if proc.returncode != 0:
            return results
    except Exception:
        return results

    current_adapter = ""
    has_gateway = False
    pending_ips: list[str] = []

    def flush_adapter() -> None:
        nonlocal pending_ips, has_gateway
        if not pending_ips:
            return
        lower_name = current_adapter.lower()
        is_virtual = any(h in lower_name for h in VIRTUAL_ADAPTER_HINTS)
        is_wifi = any(h in lower_name for h in ("wi-fi", "wifi", "wireless", "wlan"))
        is_preferred = any(h in lower_name for h in PREFERRED_ADAPTER_HINTS)

        for ip_str in pending_ips:
            if not _is_usable_lan_ipv4(ip_str):
                continue
            score = 50
            if is_virtual:
                score -= 40
            if is_wifi:
                score += 35
            elif is_preferred:
                score += 20
            if has_gateway:
                score += 25
            if ip_str.startswith("192.168."):
                score += 15
            elif ip_str.startswith("10."):
                score += 10
            elif ip_str.startswith("172."):
                score += 5
            results.append((score, ip_str, current_adapter.strip(":")))

        pending_ips = []
        has_gateway = False

    ipv4_re = re.compile(r"IPv4 Address[.\s]*:\s*([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)", re.IGNORECASE)
    gw_re = re.compile(r"Default Gateway[.\s]*:\s*([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)", re.IGNORECASE)

    for raw_line in proc.stdout.splitlines():
        line = raw_line.rstrip()
        if line and not line.startswith(" ") and line.endswith(":"):
            flush_adapter()
            current_adapter = line
            continue
        m_ip = ipv4_re.search(line)
        if m_ip:
            pending_ips.append(m_ip.group(1))
        if gw_re.search(line):
            has_gateway = True

    flush_adapter()
    return results


def _get_hostname_ips() -> list[str]:
    ips: list[str] = []
    try:
        infos = socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET)
        for info in infos:
            ip_str = info[4][0]
            if _is_usable_lan_ipv4(ip_str) and ip_str not in ips:
                ips.append(ip_str)
    except OSError:
        pass
    return ips


def detect_local_ips() -> tuple[str, list[dict[str, str]]]:
    """Detect primary Wi-Fi/LAN IPv4 address and return all candidate adapters."""
    scored = _parse_windows_ipconfig()
    default_ip = _get_default_route_ip()

    candidates: dict[str, tuple[int, str]] = {}
    for score, ip_str, adapter in scored:
        if ip_str not in candidates or score > candidates[ip_str][0]:
            candidates[ip_str] = (score, adapter)

    if default_ip:
        if default_ip in candidates:
            prev_score, adapter = candidates[default_ip]
            candidates[default_ip] = (prev_score + 20, adapter)
        else:
            candidates[default_ip] = (95, "Active Network")

    for ip_str in _get_hostname_ips():
        if ip_str not in candidates:
            score = 45 if ip_str.startswith("192.168.") else 35
            candidates[ip_str] = (score, "Local Interface")

    if not candidates:
        return "127.0.0.1", [{"ip": "127.0.0.1", "adapter": "Loopback (Offline)"}]

    ordered = sorted(
        candidates.items(),
        key=lambda item: item[1][0],
        reverse=True,
    )
    primary_ip = ordered[0][0]
    interfaces = [
        {"ip": ip_str, "adapter": adapter}
        for ip_str, (_score, adapter) in ordered
    ]
    return primary_ip, interfaces


def generate_qr_svg(data: str) -> str:
    """Generate a crisp, responsive QR code SVG string."""
    qr = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=10,
        border=2,
    )
    qr.add_data(data)
    qr.make(fit=True)
    img = qr.make_image(image_factory=SvgPathImage)
    buf = io.BytesIO()
    img.save(buf)
    svg = buf.getvalue().decode("utf-8")
    # Ensure crisp dark modules on white rounded card
    svg = svg.replace('fill="#000000"', 'fill="#0B0D12"')
    return svg


def generate_qr_png_bytes(data: str) -> bytes:
    """Generate a crisp high-resolution QR code PNG."""
    qr = qrcode.QRCode(
        version=None,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=10,
        border=3,
    )
    qr.add_data(data)
    qr.make(fit=True)
    img = qr.make_image(fill_color="#0B0D12", back_color="#FFFFFF")
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def get_network_info(port: int = 8765, public_url: str | None = None) -> dict[str, Any]:
    """Return local Wi-Fi URL (or public hosted URL in Docker/HF Spaces), QR SVG & PNG, and firewall hint."""
    if public_url:
        clean_url = public_url.rstrip("/")
        qr_svg = generate_qr_svg(clean_url)
        qr_png_b64 = base64.b64encode(generate_qr_png_bytes(clean_url)).decode("ascii")
        return {
            "ip": "cloud",
            "port": port,
            "url": clean_url,
            "is_lan": False,
            "interfaces": [{"ip": "HTTPS", "adapter": "Public Space", "url": clean_url}],
            "qr_svg": qr_svg,
            "qr_png_data_url": f"data:image/png;base64,{qr_png_b64}",
            "firewall_command": "No firewall rule needed when hosted on Hugging Face Spaces.",
        }

    primary_ip, interfaces = detect_local_ips()
    url = f"http://{primary_ip}:{port}"
    qr_svg = generate_qr_svg(url)
    qr_png_b64 = base64.b64encode(generate_qr_png_bytes(url)).decode("ascii")

    all_urls = [
        {
            "ip": item["ip"],
            "adapter": item["adapter"],
            "url": f"http://{item['ip']}:{port}",
        }
        for item in interfaces
    ]

    firewall_cmd = (
        f"New-NetFirewallRule -DisplayName 'LocalReader TTS (TCP {port})' "
        f"-Direction Inbound -Protocol TCP -LocalPort {port} "
        f"-Profile Private -Action Allow"
    )

    return {
        "ip": primary_ip,
        "port": port,
        "url": url,
        "is_lan": primary_ip != "127.0.0.1",
        "interfaces": all_urls,
        "qr_svg": qr_svg,
        "qr_png_data_url": f"data:image/png;base64,{qr_png_b64}",
        "firewall_command": firewall_cmd,
    }
