const fs = require("fs");
const fetch = require("node-fetch");

const username = process.env.GITHUB_USER;
const token = process.env.GITHUB_TOKEN;
const now = new Date();

const startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

async function getCommits() {
  const url = `https://api.github.com/search/commits?q=author:${username}+committer-date:>${startDate}`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/vnd.github.cloak-preview",
      Authorization: `token ${token}`
    }
  });
  const data = await res.json();
  return data.items || [];
}

function splitCommitsByTime(commits) {
  let morning = 0, evening = 0;
  commits.forEach(c => {
    const commitTime = new Date(c.commit.author.date);
    const hoursIST = new Date(commitTime.toLocaleString("en-US", { timeZone: "Asia/Kolkata" })).getHours();
    if (hoursIST < 12) morning++;
    else evening++;
  });
  return { morning, evening };
}

(async () => {
  const commits = await getCommits();
  const { morning, evening } = splitCommitsByTime(commits);

  const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });

  let readme = fs.readFileSync("README.md", "utf-8");

  const tableRow = `| ${today} | ${morning} commits   | ${evening} commits   |`;

  readme = readme.replace(
    /(<!--START_SECTION:commits-->)([\s\S]*?)(<!--END_SECTION:commits-->)/,
    `$1\n| Date       | 00:00–11:59 | 12:00–23:59 |\n|------------|-------------|-------------|\n${tableRow}\n$3`
  );

  readme = readme.replace(
    /(<!--START_SECTION:dailycommits-->)([\s\S]*?)(<!--END_SECTION:dailycommits-->)/,
    `$1\n| Date       | Morning     | Evening     |\n|------------|-------------|-------------|\n${tableRow}\n$3`
  );

  fs.writeFileSync("README.md", readme);
})();
