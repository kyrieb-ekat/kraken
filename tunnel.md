# Accessing the Interface Remotely

## On your machine (one-time setup)

```bash
conda activate kraken
cd ~/Documents/kraken
uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

The server listens on localhost only — it is not directly reachable from the network.

## On your colleague's machine (while on VPN)

```bash
ssh -L 8080:localhost:8000 kyrie@<your-hostname-or-ip>
```

Replace `<your-hostname-or-ip>` with your machine's hostname or IP address on the VPN network. The tunnel forwards her local port 8080 to your machine's port 8000.

She then opens: **http://localhost:8080**

The SSH session must stay open while she is using the interface. She can use `-N` to suppress the shell:

```bash
ssh -N -L 8080:localhost:8000 kyrie@<your-hostname-or-ip>
```

## Finding your hostname

```bash
hostname
```

Or check System Settings → General → Sharing → Local Hostname.
