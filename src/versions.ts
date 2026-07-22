interface GitHubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
}

/** Paginated `GET /repos/rtk-ai/rtk/releases`, latest first — only hit when the user invokes the picker. */
export async function listRtkReleases(): Promise<string[]> {
  const tags: string[] = [];
  for (let page = 1; page <= 5; page += 1) {
    const res = await fetch(`https://api.github.com/repos/rtk-ai/rtk/releases?per_page=100&page=${page}`, {
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!res.ok) break;
    const releases = (await res.json()) as GitHubRelease[];
    if (releases.length === 0) break;
    tags.push(...releases.filter((r) => !r.draft && !r.prerelease).map((r) => r.tag_name));
    if (releases.length < 100) break;
  }
  return tags;
}

interface PyPiPackageInfo {
  releases: Record<string, unknown[]>;
}

/** `releases` keys are already every published version — no rate-limit concerns like GitHub. */
export async function listHeadroomReleases(): Promise<string[]> {
  const res = await fetch('https://pypi.org/pypi/headroom-ai/json');
  if (!res.ok) return [];
  const info = (await res.json()) as PyPiPackageInfo;
  return Object.keys(info.releases).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0));
}
