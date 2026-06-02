# Kraken Training Interface

A web application for training [Kraken](https://kraken.re) OCR models on medieval manuscripts. It lets a user review and correct transcriptions and manage training runs through a browser — including from a remote machine over a VPN.

---

## Contents

- [Part 1 — Host machine setup](#part-1--host-machine-setup) *(the person whose computer will run the training)*
- [Part 2 — Remote user guide](#part-2--remote-user-guide) *(the person connecting from another machine to do the work)*

---

## Part 1 — Host machine setup

This is for the person whose computer will actually run the Kraken training. You only need to do most of this once.

### Prerequisites

- **macOS or Linux**
- **[Miniconda](https://docs.conda.io/en/latest/miniconda.html)** (or Anaconda) installed
- **Git** installed

### 1. Clone the repository

```bash
git clone <repo-url> ~/Documents/kraken
cd ~/Documents/kraken
```

### 2. Create the conda environment

This installs Python, Kraken, and all other dependencies into an isolated environment.

```bash
conda env create -f environment.yml
```

This will take a few minutes the first time. You only need to do it once.

### 3. Start the server

Run this script whenever you want to make the interface available:

```bash
./start.sh
```

You should see:

```
Starting Kraken Training Interface at http://localhost:8000
```

The server will keep running in that terminal window. **Keep the window open** while the interface is in use. Press `Ctrl+C` to stop it.

> **Tip:** If you want to run it in the background so you can close the terminal, use:
> ```bash
> nohup ./start.sh &> data/logs/server.log &
> ```

### 4. Find your machine's hostname

Your colleague will need this to connect. Run:

```bash
hostname
```

Or go to **System Settings → General → Sharing** and look for **Local Hostname**. It will look something like `kyries-macbook-pro.local`.

### 5. (Optional) Set up SSH key access

So your colleague doesn't need a password every time she connects:

On **her** machine, run:

```bash
ssh-keygen   # only if she doesn't already have a key
ssh-copy-id kyrie@<your-hostname>
```

---

## Part 2 — Remote user guide

This is for the person who will be doing the transcription review and training work from their own computer. Your colleague's machine must be **on the same VPN** as yours and must have the server running (see Part 1 above).

### Connecting

Open a terminal and run:

```bash
ssh -N -L 8080:localhost:8000 kyrie@<hostname>
```

Replace `kyrie` with your colleague's username and `<hostname>` with her machine's hostname (e.g. `kyries-macbook-pro.local`). You may be asked for a password.

The `-N` flag means the terminal won't open a shell — it just holds the connection open. **Leave this terminal window open** while you work.

Then open your browser and go to:

**http://localhost:8080**

---

### Workflow

#### Step 1 — Upload a CSV

Go to the **Datasets** tab and drag your Cantus Database export (`.csv`) into the upload area. The app reads each row's folio label, manuscript image URL, and transcription text.

Once uploaded, your dataset appears in the table below with a count of folios found.

#### Step 2 — Download page images

Click **View Folios** next to your dataset to see all the manuscript pages. Then click **Download Images** to have the app fetch each page from the image URLs in the CSV.

If a download fails (e.g. the image is access-restricted), an **Upload Image** button appears next to that folio so you can supply the image manually. You can also click **Upload ZIP** to upload a folder of images all at once — filenames should match the folio label (e.g. `001v.png`).

#### Step 3 — Segment a page

Switch to the **Review** tab. Select your dataset and then a folio from the dropdowns. Click **Segment Page** — Kraken will analyse the image and draw outlines around each line of text it detects.

This takes a moment. When it finishes, the page image appears on the left with coloured polygons over each detected line, and the line list appears on the right.

#### Step 4 — Review and correct transcriptions

Each line shows a suggested transcription drawn from the CSV. Because one CSV row (chant) can span several physical lines, you will usually need to adjust things:

- **Edit text** — click into the text box next to any line and type your corrections.
- **Split a line** — if Kraken combined two chants into one line, click **Split** (or press **S**) and then click the split point on the page image.
- **Merge two lines** — if one chant runs across two lines, select both and click **Merge** (or press **M** with one selected, then click the other).
- **Delete a line** — if Kraken detected a decoration or ruling instead of text, click **Delete** (or press **Delete/Backspace**).
- **Add a line** — if Kraken missed a line entirely, click **+ Add Line** (or press **A**) and draw a polygon around the line on the page image.
- **Edit a polygon** — if a line's outline is badly shaped, click the **Edit** button to drag the polygon's vertices into a better shape. Press **Done Editing** to save or **Esc** to cancel.

The **Text Pool** panel (bottom right) lists all chants from the CSV for this folio. Click any entry to copy it into whichever line's text box is currently active. Note that **entry 0** is the last chant from the *previous* page — this is there because chants are listed on the page they *start* on, but the final chant of a page often continues onto the next one.

When a line looks correct, tick **Confirmed**. Use **Confirm All** to mark an entire folio done at once.

Press **?** at any time to see the full list of keyboard shortcuts.

#### Step 5 — Compile and train

Switch to the **Training** tab.

1. Under **Compile Ground Truth**, select your dataset and click **Compile GT**. This packages all confirmed lines into a training archive.
2. Under **Start Training Run**, give the run a name, set the number of epochs, and optionally choose a base model to fine-tune from. Then click **Start Training**.

The **Live Log** panel streams Kraken's output in real time so you can watch progress. You can stop a run at any time and resume from a checkpoint later.

#### Step 6 — Download your model

When training finishes, go to the **Models** tab. Your trained `.mlmodel` file will be listed there with a **Download** button.

---

### Updating the CSV without losing your work

If you need to refresh the transcription data (for example, after correcting the CSV), click **↺ Re-upload** on the dataset row and select the new CSV file. This updates all text pools and adds any new folios, but leaves your segmentation and transcription work completely intact.

To delete a dataset entirely, click the **🗑** button and confirm. This cannot be undone.
