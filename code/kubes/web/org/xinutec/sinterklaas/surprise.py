import os
import random
import uuid
import smtplib
import json
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart

# ==========================================
# CONFIGURATION - EDIT THIS BEFORE RUNNING
# ==========================================

# SMTP Settings (For sending the emails)
SMTP_SERVER = "smtp.gmail.com"
SMTP_PORT = 587
# LOGIN CREDENTIALS (Must be the primary account)
SMTP_LOGIN_USER = "pip88nl@gmail.com"

# EMAIL "FROM" ADDRESS (Can be an alias if configured in Gmail)
SMTP_SENDER_EMAIL = "Sinterklaas <pip88nl+sinterklaas@gmail.com>"

# Participants List
# Format: "Name": {"email": "email@address.com", "file": "path/to/wishlist.txt"}
PARTICIPANTS = {
    "Astrid": {"email": "asvanst33@t-online.de", "file": "wishes_astrid.txt"},
    "Karel": {"email": "kvs33@t-online.de", "file": "wishes_karel.txt"},
    "Jasper": {"email": "jaspervansteenhoven@gmail.com", "file": "wishes_jasper.txt"},
    "Alina": {"email": "alina_strehl@hotmail.com", "file": "wishes_alina.txt"},
    "Pippijn": {"email": "pip88nl@gmail.com", "file": "wishes_pippijn.txt"},
    "Michiel": {"email": "shadowiii@hotmail.com", "file": "wishes_michiel.txt"},
}

# The public URL where the site is hosted
BASE_URL = "https://sinterklaas.xinutec.org"

import argparse
import subprocess

# ==========================================
# LOGIC
# ==========================================

def get_derangement(names):
    """Generates a mapping where no one is assigned to themselves."""
    while True:
        shuffled = names[:]
        random.shuffle(shuffled)
        if all(x != y for x, y in zip(names, shuffled)):
            return dict(zip(names, shuffled))

def create_configmap(secret_data):
    """Generates the Kubernetes ConfigMap YAML."""
    
    # We embed the JSON data directly into the HTML or a separate JSON file in the ConfigMap
    # For simplicity, we will create a 'secrets.json' inside the ConfigMap
    
    html_content = """<!DOCTYPE html>
<html>
<head>
    <title>Sinterklaas Surprise</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link href="https://fonts.googleapis.com/css2?family=Mountains+of+Christmas:wght@700&family=Lora:ital@0;1&display=swap" rel="stylesheet">
    <style>
        body {
            font-family: 'Lora', serif;
            background-color: #a61c1c;
            background-image: radial-gradient(circle, #b72c2c 10%, transparent 10%), radial-gradient(circle, #b72c2c 10%, transparent 10%);
            background-size: 20px 20px;
            background-position: 0 0, 10px 10px;
            padding: 20px;
            text-align: center;
            color: #333;
        }
        .container {
            max-width: 600px;
            margin: 40px auto;
            background: #fff8e1; /* Parchment color */
            padding: 40px;
            border: 8px double #d4af37; /* Gold border */
            border-radius: 4px;
            box-shadow: 0 10px 20px rgba(0,0,0,0.3);
            position: relative;
        }
        .container::before {
            content: "★";
            font-size: 40px;
            color: #d4af37;
            position: absolute;
            top: -25px;
            left: 50%;
            transform: translateX(-50%);
            background: #a61c1c;
            border-radius: 50%;
            padding: 0 10px;
            border: 2px solid #d4af37;
        }
        h1 {
            font-family: 'Mountains of Christmas', cursive;
            color: #8b0000;
            font-size: 3em;
            margin-bottom: 10px;
            text-shadow: 1px 1px 2px rgba(0,0,0,0.1);
        }
        p { font-size: 1.1em; color: #555; }
        
        input {
            padding: 12px;
            font-size: 18px;
            width: 70%;
            margin: 20px 0;
            text-align: center;
            border: 2px solid #d4af37;
            border-radius: 4px;
            background: #fff;
            font-family: 'Courier New', monospace;
        }
        input:focus { outline: none; border-color: #8b0000; }
        
        button {
            padding: 12px 30px;
            font-size: 18px;
            background: #8b0000;
            color: #fff;
            border: none;
            border-radius: 30px;
            cursor: pointer;
            font-family: 'Mountains of Christmas', cursive;
            transition: transform 0.2s, background 0.2s;
            box-shadow: 0 4px 6px rgba(0,0,0,0.2);
        }
        button:hover { background: #a00000; transform: scale(1.05); }

        .result {
            display: none;
            margin-top: 30px;
            border-top: 2px dashed #d4af37;
            padding-top: 20px;
            animation: fadeIn 1s ease-in-out;
        }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }

        h2 { color: #8b0000; font-size: 1.8em; margin-bottom: 20px; }
        .target-name { color: #d62828; font-weight: bold; font-size: 1.2em; text-decoration: underline decoration-wavy #d4af37; }

        .wishlist-container {
            text-align: left;
            background: #fff;
            padding: 20px;
            border-radius: 8px;
            border: 1px solid #e0e0e0;
            box-shadow: inset 0 0 10px rgba(0,0,0,0.05);
        }
        ul { list-style-type: none; padding: 0; }
        li {
            padding: 8px 0;
            padding-left: 30px;
            position: relative;
            font-size: 1.1em;
            line-height: 1.5;
            border-bottom: 1px solid #f0f0f0;
        }
        li:last-child { border-bottom: none; }
        li::before {
            content: "🎁";
            position: absolute;
            left: 0;
            top: 8px;
            font-size: 1.2em;
        }

        /* Countdown Timer */
        #countdown {
            font-family: 'Mountains of Christmas', cursive;
            font-size: 1.5em;
            color: #d4af37;
            background: rgba(139, 0, 0, 0.9);
            padding: 10px 20px;
            border-radius: 50px;
            display: inline-block;
            margin-bottom: 20px;
            box-shadow: 0 4px 6px rgba(0,0,0,0.3);
            border: 2px solid #d4af37;
        }

        /* Falling Pepernoten */
        .falling-container {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            pointer-events: none;
            overflow: hidden;
            z-index: 9999;
        }
        .falling-item {
            position: absolute;
            top: -50px;
            font-size: 24px;
            animation: fall linear forwards;
        }
        @keyframes fall {
            to { transform: translateY(110vh) rotate(360deg); }
        }
    </style>
</head>
<body>
    <div class="falling-container" id="rain"></div>

    <div id="countdown">Nog <span id="timer">...</span> tot Pakjesavond!</div>

    <div class="container">
        <h1>Sinterklaas Surprise</h1>
        <p>Welkom, Helper van de Sint! <br> Vul hier de geheime code in die je per email hebt ontvangen:</p>
        
        <input type="text" id="code" placeholder="bv. A1B2C3" autocomplete="off">
        <br>
        <button onclick="reveal()">Open Het Boek</button>

        <div id="result" class="result">
            <h2>Jij maakt een surprise voor:<br><br><span id="targetName" class="target-name"></span></h2>
            <div class="wishlist-container" id="wishesArea"></div>
        </div>
    </div>

    <script>
        // --- Countdown Timer ---
        function updateCountdown() {
            const now = new Date();
            const currentYear = now.getFullYear();
            let target = new Date(currentYear, 11, 6, 18, 0, 0); // Dec 6th, 18:00 (Month is 0-indexed)

            // If we are past Dec 6th 18:00, target next year? Or just say "Fijne Pakjesavond!"
            if (now > target) {
                 if (now.getDate() === 6 && now.getMonth() === 11) {
                     document.getElementById('countdown').innerHTML = "🎁 Fijne Pakjesavond! 🎁";
                     return;
                 }
                 target.setFullYear(currentYear + 1);
            }

            const diff = target - now;
            
            const days = Math.floor(diff / (1000 * 60 * 60 * 24));
            const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
            const seconds = Math.floor((diff % (1000 * 60)) / 1000);

            document.getElementById('timer').innerText = `${days}d ${hours}u ${minutes}m ${seconds}s`;
        }
        setInterval(updateCountdown, 1000);
        updateCountdown();

        // --- Pepernoten Rain ---
        function createRain() {
            const container = document.getElementById('rain');
            const items = ['🍪', '🍊', '🎁', '🍬', '🍫', '🧸'];
            
            const el = document.createElement('div');
            el.classList.add('falling-item');
            el.innerText = items[Math.floor(Math.random() * items.length)];
            el.style.left = Math.random() * 100 + 'vw';
            el.style.animationDuration = (Math.random() * 3 + 2) + 's'; // 2-5s fall time
            el.style.fontSize = (Math.random() * 20 + 20) + 'px'; // 20-40px size
            
            container.appendChild(el);

            // Remove after animation ends
            setTimeout(() => { el.remove(); }, 5000);
        }
        setInterval(createRain, 300); // New item every 300ms

        // --- Existing Logic ---
        async function reveal() {
            const code = document.getElementById('code').value.trim();
            if (!code) return alert("Vul aub de geheime code in!");

            try {
                const response = await fetch('secrets.json');
                if (!response.ok) throw new Error("Network response was not ok");
                const data = await response.json();
                
                if (data[code]) {
                    document.getElementById('targetName').innerText = data[code].name;
                    
                    // Format the wishes
                    const rawWishes = data[code].wishes;
                    const container = document.getElementById('wishesArea');
                    container.innerHTML = formatWishes(rawWishes);
                    
                    document.getElementById('result').style.display = 'block';
                } else {
                    alert("Die code staat niet in het Grote Boek (Ongeldige Code).");
                }
            } catch (e) {
                alert("De pieten hebben de verbinding verbroken. Probeer het opnieuw.");
                console.error(e);
            }
        }

        function formatWishes(text) {
            const lines = text.split('\\n');
            let html = '<ul>';
            let hasList = false;

            lines.forEach(line => {
                const trimmed = line.trim();
                if (!trimmed) return;

                if (trimmed.startsWith('-') || trimmed.startsWith('*')) {
                    // It's a list item
                    html += `<li>${trimmed.substring(1).trim()}</li>`;
                    hasList = true;
                } else {
                    // It's a header or plain text, close list if open? 
                    // For simplicity, we'll just treat everything as a list item if it looks like a list, 
                    // or plain paragraph if it doesn't.
                    if (hasList) {
                        html += '</ul><p>' + trimmed + '</p><ul>';
                    } else {
                         html = `<p>${trimmed}</p><ul>`;
                    }
                }
            });
            html += '</ul>';
            
            // Cleanup empty lists if any
            return html.replace(/<ul><\/ul>/g, '');
        }
    </script>
</body>
</html>"""

    # Create the ConfigMap YAML
    yaml = f"""apiVersion: v1
kind: ConfigMap
metadata:
  namespace: web
  name: sinterklaas-html
data:
  index.html: |
{indent(html_content, 4)}
  secrets.json: |
{indent(json.dumps(secret_data, indent=2), 4)}
"""
    return yaml

def indent(text, spaces):
    return "\n".join(" " * spaces + line for line in text.splitlines())

def send_email(to_email, name, code, password):
    subject = "Jouw Sinterklaas Surprise Lootje"
    body = f"""Hallo {name},

De Sint heeft de lootjes geschud!

Jouw geheime code is: {code}

Ga naar {BASE_URL} en vul deze code in om te zien wie je hebt getrokken en wat diegene wil hebben.

Houd deze code geheim!

Groetjes,
De Sint
"""
    
    msg = MIMEMultipart()
    msg['From'] = SMTP_SENDER_EMAIL
    msg['To'] = to_email
    msg['Subject'] = subject
    msg.attach(MIMEText(body, 'plain'))

    try:
        server = smtplib.SMTP(SMTP_SERVER, SMTP_PORT)
        server.starttls()
        # Login with the PRIMARY account credentials
        server.login(SMTP_LOGIN_USER, password)
        # Send from the ALIAS address
        server.sendmail(SMTP_SENDER_EMAIL, to_email, msg.as_string())
        server.quit()
        print(f"Email sent to {name}")
    except Exception as e:
        print(f"FAILED to send email to {name}: {e}")

def main():
    parser = argparse.ArgumentParser(description="Sinterklaas Surprise Manager")
    parser.add_argument("--send-email", action="store_true", help="Actually send the emails to participants.")
    parser.add_argument("--smoke-test", action="store_true", help="Send email ONLY to Pippijn for testing.")
    parser.add_argument("--smtp-password", type=str, help="App Password for the Gmail account.")
    args = parser.parse_args()

    if (args.send_email or args.smoke_test) and not args.smtp_password:
        parser.error("--smtp-password is required when sending emails (either --send-email or --smoke-test).")

    names = list(PARTICIPANTS.keys())
    
    # 1. Verify files exist
    for name, data in PARTICIPANTS.items():
        if not os.path.exists(data['file']):
            print(f"Creating dummy file for {name} at {data['file']} (please edit it!)")
            with open(data['file'], 'w') as f:
                f.write(f"Dear Santa, {name} wants chocolate letters and marzipan.")

    # 2. Shuffle
    mapping = get_derangement(names)
    
    # 3. Generate Codes and Secret Data
    secret_db = {}
    
    print("\n--- GENERATING BLIND ASSIGNMENTS ---")
    if args.send_email:
        print("!!! SENDING EMAILS ENABLED (ALL) !!!")
    elif args.smoke_test:
         print("!!! SMOKE TEST MODE: Sending email ONLY to Pippijn !!!")
    else:
        print("(Dry Run: No emails will be sent. Use --send-email to send.)")
    
    for giver, receiver in mapping.items():
        unique_code = str(uuid.uuid4()).split('-')[0] # Short random code
        
        # Read the receiver's wish list
        with open(PARTICIPANTS[receiver]['file'], 'r') as f:
            wishes = f.read()

        # Store in the database (Code -> Receiver Data)
        # Note: We do NOT store 'giver' here, so the frontend JSON doesn't know who the giver is.
        secret_db[unique_code] = {
            "name": receiver,
            "wishes": wishes
        }

        # Send the code to the Giver
        print(f"Preparing assignment for {giver}...")
        
        should_send = False
        if args.smoke_test:
            if giver == "Pippijn":
                should_send = True
        elif args.send_email:
            should_send = True
            
        if should_send:
            send_email(PARTICIPANTS[giver]['email'], giver, unique_code, args.smtp_password)
        else:
             print(f"  [Skipped] Would email {giver} ({PARTICIPANTS[giver]['email']}) with code: {unique_code}")

    # 4. Generate K8s Config
    k8s_yaml = create_configmap(secret_db)
    
    filename = "sinterklaas_configmap.yaml"
    with open(filename, "w") as f:
        f.write(k8s_yaml)
    
    print(f"\nDone! '{filename}' created.")
    
    # 5. Apply to Kubernetes
    print("Applying configuration to Kubernetes...")
    try:
        subprocess.check_call(["sudo", "kubectl", "apply", "-f", filename])
        subprocess.check_call(["sudo", "kubectl", "rollout", "restart", "deployment/httpd-sinterklaas", "-n", "web"])
        print("\nSUCCESS: Deployment updated and restarted!")
    except subprocess.CalledProcessError as e:
        print(f"\nERROR: Failed to update Kubernetes. Command failed with exit code {e.returncode}")
    except FileNotFoundError:
        print("\nERROR: 'kubectl' command not found.")

if __name__ == "__main__":
    main()
