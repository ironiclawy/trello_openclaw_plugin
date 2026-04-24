(function () {
  var t = window.TrelloPowerUp.iframe();

  function normalizeConfig(raw) {
    var cfg = raw || {};
    return {
      statsUrl: String(cfg.statsUrl || "").trim(),
      statsToken: String(cfg.statsToken || "").trim(),
      instanceName: String(cfg.instanceName || "").trim(),
    };
  }

  function number(value) {
    return Number(value || 0).toLocaleString();
  }

  function setError(message) {
    var el = document.getElementById("error");
    el.textContent = message;
    el.style.display = message ? "block" : "none";
  }

  function renderSummary(stats) {
    var sessions = (stats && stats.sessions) || {};
    var usage = (stats && stats.usage) || {};
    var html = [
      ["Sessions Started", number(sessions.started)],
      ["Sessions Active", number(sessions.active)],
      ["Sessions Completed", number(sessions.completed)],
      ["Sessions Failed", number(sessions.failed)],
      ["Dispatches", number(usage.dispatches)],
      ["Dispatch Errors", number(usage.dispatchErrors)],
      ["Total Tokens", number(usage.totalTokens)],
      ["Prompt Tokens", number(usage.promptTokens)],
      ["Completion Tokens", number(usage.completionTokens)],
    ]
      .map(function (pair) {
        return '<div class="card"><div class="label">' + pair[0] + '</div><div class="value">' + pair[1] + "</div></div>";
      })
      .join("");

    document.getElementById("summary").innerHTML = html;

    var generatedAt = Number((stats && stats.generatedAt) || 0);
    document.getElementById("generatedAt").textContent = generatedAt
      ? "Updated " + new Date(generatedAt).toLocaleString()
      : "No timestamp";
  }

  function renderAgents(stats) {
    var rows = ((stats && stats.agents) || [])
      .map(function (agent) {
        return "<tr>" +
          "<td>" + String(agent.agentId || "unknown") + "</td>" +
          "<td>" + number(agent.dispatches) + "</td>" +
          "<td>" + number(agent.totalTokens) + "</td>" +
          "<td>" + number(agent.promptTokens) + "</td>" +
          "<td>" + number(agent.completionTokens) + "</td>" +
          "</tr>";
      })
      .join("");

    document.getElementById("agentRows").innerHTML = rows || '<tr><td colspan="5" class="u-quiet">No activity yet.</td></tr>';
  }

  async function resolveStatsConfig() {
    // Prefer signed args from board-button callback when present.
    var argConfig = normalizeConfig({
      statsUrl: t.arg("statsUrl") || "",
      statsToken: t.arg("statsToken") || "",
      instanceName: t.arg("instanceName") || "",
    });

    if (argConfig.statsUrl) {
      return argConfig;
    }

    // Fallback to board shared config so modal still works even if args are missing.
    var boardConfig = await t.get("board", "shared", "openclawStatsConfig");
    return normalizeConfig(boardConfig);
  }

  async function loadStats() {
    setError("");
    var cfg = await resolveStatsConfig();
    var statsUrl = cfg.statsUrl;
    if (!statsUrl) {
      setError("Stats endpoint is not configured for this board. Open Power-Up settings (gear icon) and run setup/import.");
      return;
    }

    var token = cfg.statsToken;
    var url = new URL(statsUrl);
    if (token) {
      url.searchParams.set("token", token);
    }

    try {
      var response = await fetch(url.toString(), {
        method: "GET",
        credentials: "omit",
      });
      if (!response.ok) {
        throw new Error("HTTP " + response.status + " from stats endpoint");
      }
      var data = await response.json();
      renderSummary(data);
      renderAgents(data);
      await t.sizeTo("#app");
    } catch (err) {
      setError("Failed loading stats: " + (err && err.message ? err.message : String(err)));
      await t.sizeTo("#app");
    }
  }

  document.getElementById("refreshBtn").addEventListener("click", loadStats);

  t.render(function () {
    loadStats();
  });
})();
