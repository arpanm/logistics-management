# India Post postal directory

`india-post-pincode-directory-ogd-2025-10-03.csv` is the pinned production
input downloaded from the Government of India Open Government Data resource
[All India Pincode Directory till last month](https://www.data.gov.in/resource/all-india-pincode-directory-till-last-month).

- Resource metadata date/version: `2025-10-03` / `ogd-2025-10-03`
- Records: `165,627` plus the CSV header
- Canonical rows after deterministic duplicate removal: `165,619`
- SHA-256: `701ee84ba125a914e7ffc979c0308b3a041b8adffa85ec9d5f4e0579ecf062e5`
- Installed production path: `/opt/logistics-secrets/india-post-pincode-directory.csv`

The first-install script verifies this checksum before copying the file to its
protected runtime path. Replace the dataset only through a reviewed update that
also changes the version, checksum, source metadata, and this file.
