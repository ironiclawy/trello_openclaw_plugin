(function () {
  var t = window.TrelloPowerUp.iframe();
  var statusEl = document.getElementById("status");
  var refreshMembersBtn = document.getElementById("refreshMembersBtn");
  var membersStatusEl = document.getElementById("membersStatus");
  var memberTogglesEl = document.getElementById("memberToggles");

  function setStatus(message, kind) {
    statusEl.textContent = message || "";
    statusEl.className = "status" + (kind ? " " + kind : "");
  }

  function getValue(id) {
    return String(document.getElementById(id).value || "").trim();
  }

  function setValue(id, value) {
    document.getElementById(id).value = value || "";
  }

  function setMembersStatus(message, kind) {
    membersStatusEl.textContent = message || "";
    membersStatusEl.className = "hint" + (kind ? " " + kind : "");
  }

  function normalizeMemberIdList(value) {
    if (!Array.isArray(value)) return [];
    var seen = new Set();
    var ids = [];
    value.forEach(function (memberId) {
      var normalized = String(memberId || "").trim();
      if (!normalized || seen.has(normalized)) return;
      seen.add(normalized);
      ids.push(normalized);
    });
    return ids;
  }

  function getSelectedAgentMemberIds() {
    var checkboxes = Array.prototype.slice.call(document.querySelectorAll('input[name="agentMemberIds"]'));
    return normalizeMemberIdList(
      checkboxes
        .filter(function (checkbox) { return checkbox.checked; })
        .map(function (checkbox) { return checkbox.value; })
    );
  }

  function renderMemberToggles(members, selectedIds) {
    var selected = new Set(normalizeMemberIdList(selectedIds));
    if (!members || !members.length) {
      memberTogglesEl.textContent = "No board members returned.";
      setMembersStatus("No members were returned for this board.", "");
      return;
    }

    var html = members.map(function (member) {
      var id = String(member.id || "");
      var fullName = String(member.fullName || "").trim();
      var username = String(member.username || "").trim();
      var label = fullName || username || id;
      var hint = username ? " @" + username : "";
      var suggested = member.suggestedAgent ? " <span class=\"hint\">(_bot)</span>" : "";
      var checked = selected.has(id) || !!member.configuredAgent;
      return (
        '<label style="display:block;margin:4px 0;">' +
        '<input type="checkbox" name="agentMemberIds" value="' + id + '"' + (checked ? ' checked' : '') + ' /> ' +
        label + hint + suggested +
        '</label>'
      );
    }).join("");

    memberTogglesEl.innerHTML = html;
    setMembersStatus("Loaded " + members.length + " board member" + (members.length === 1 ? "" : "s") + ". Select automation agents and click Save Config.", "ok");
  }

  function validateHttpsUrl(value) {
    var url;
    try {
      url = new URL(String(value || ""));
    } catch (_err) {
      throw new Error("Stats URL must be a valid URL.");
    }
    if (url.protocol !== "https:") {
      throw new Error("Stats URL must use https.");
    }
    return url.toString();
  }

  function deriveGatewayOrigin(statsUrl) {
    var parsed = new URL(validateHttpsUrl(statsUrl));
    return parsed.origin;
  }

  async function getBoardId() {
    return t.board("id").get("id");
  }

  async function saveBoardConfig(config) {
    await t.set("board", "shared", "openclawStatsConfig", config);
  }

  async function loadBoardConfig() {
    var cfg = (await t.get("board", "shared", "openclawStatsConfig")) || {};
    setValue("statsUrl", cfg.statsUrl || "");
    setValue("statsToken", cfg.statsToken || "");
    setValue("instanceName", cfg.instanceName || "");
    if (cfg.statsUrl) {
      setMembersStatus("Click Refresh Members to load current board members.", "");
    } else {
      setMembersStatus("Set Stats endpoint URL, then click Refresh Members.", "");
    }
    memberTogglesEl.textContent = "";
    return cfg;
  }

  async function loadBoardMembers(prefilledSelectedIds) {
    var statsUrl = getValue("statsUrl");
    if (!statsUrl) {
      throw new Error("Set Stats endpoint URL first, then click Refresh Members.");
    }

    var boardId = await getBoardId();
    var origin = deriveGatewayOrigin(statsUrl);
    var url = new URL(origin + "/trello/powerup/board-members");
    url.searchParams.set("boardId", boardId);

    var response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
      },
    });
    var body = await response.json().catch(function () {
      return {};
    });
    if (!response.ok) {
      throw new Error(body.error || ("HTTP " + response.status));
    }

    var selected = normalizeMemberIdList(prefilledSelectedIds);
    renderMemberToggles((body && body.members) || [], selected);
  }

  async function postJsonToOpenClaw(path, payload) {
    var statsUrl = getValue("statsUrl");
    if (!statsUrl) {
      throw new Error("Set Stats endpoint URL first.");
    }
    var origin = deriveGatewayOrigin(statsUrl);
    var response = await fetch(origin + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload || {}),
    });
    var body = await response.json().catch(function () {
      return {};
    });
    if (!response.ok) {
      throw new Error(body.error || ("HTTP " + response.status));
    }
    return body;
  }

  async function onSaveClick() {
    try {
      var statsUrl = validateHttpsUrl(getValue("statsUrl"));
      var config = {
        statsUrl: statsUrl,
        statsToken: getValue("statsToken"),
        instanceName: getValue("instanceName"),
        agentMemberIds: getSelectedAgentMemberIds(),
        updatedAt: Date.now(),
      };
      await saveBoardConfig(config);
      setStatus("Saved board config.", "ok");
    } catch (err) {
      setStatus(err.message || String(err), "error");
    }
    await t.sizeTo("#app");
  }

  async function onCreateSetupClick() {
    try {
      var boardId = await getBoardId();
      var result = await postJsonToOpenClaw("/trello/powerup/setup-card", { boardId: boardId });
      if (result.cardId) {
        setValue("setupCardId", result.cardId);
      }
      setStatus("Created setup card. Open it in Trello, fill values, then click Import + Archive.", "ok");
    } catch (err) {
      setStatus(err.message || String(err), "error");
    }
    await t.sizeTo("#app");
  }

  async function onImportClick() {
    try {
      var cardId = getValue("setupCardId");
      if (!cardId) {
        throw new Error("Setup card ID is required for import.");
      }
      var boardId = await getBoardId();
      var result = await postJsonToOpenClaw("/trello/powerup/setup-import", {
        boardId: boardId,
        cardId: cardId,
      });
      var importedConfig = result.config || {};
      setValue("statsUrl", importedConfig.statsUrl || "");
      setValue("statsToken", importedConfig.statsToken || "");
      setValue("instanceName", importedConfig.instanceName || "");
      renderMemberToggles([], importedConfig.agentMemberIds || []);
      await loadBoardMembers(importedConfig.agentMemberIds || []);
      await saveBoardConfig({
        statsUrl: importedConfig.statsUrl || "",
        statsToken: importedConfig.statsToken || "",
        instanceName: importedConfig.instanceName || "",
        agentMemberIds: normalizeMemberIdList(importedConfig.agentMemberIds || []),
        updatedAt: Date.now(),
      });
      setStatus("Imported config and archived setup card.", "ok");
    } catch (err) {
      setStatus(err.message || String(err), "error");
    }
    await t.sizeTo("#app");
  }

  document.getElementById("saveBtn").addEventListener("click", onSaveClick);
  document.getElementById("createSetupBtn").addEventListener("click", onCreateSetupClick);
  document.getElementById("importBtn").addEventListener("click", onImportClick);
  refreshMembersBtn.addEventListener("click", async function () {
    refreshMembersBtn.disabled = true;
    setMembersStatus("Refreshing board members...", "");
    try {
      await loadBoardMembers(getSelectedAgentMemberIds());
      setStatus("Loaded board members. Save Config to persist selected agents.", "ok");
    } catch (err) {
      var message = err.message || String(err);
      setMembersStatus("Refresh failed: " + message, "error");
      setStatus(message, "error");
    } finally {
      refreshMembersBtn.disabled = false;
    }
    await t.sizeTo("#app");
  });

  t.render(async function () {
    setStatus("", "");
    var cfg = await loadBoardConfig();
    try {
      await loadBoardMembers((cfg && cfg.agentMemberIds) || []);
    } catch (_err) {
      // Keep settings usable if member polling fails; user can retry manually.
    }
    await t.sizeTo("#app");
  });
})();
