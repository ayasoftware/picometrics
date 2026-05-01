/**
 * GTM MCP Server
 * Transport: StreamableHTTP (stateless per-request mode)
 * Security: X-Internal-Secret header required on every request
 * Auth: Workspace OAuth token passed via X-Workspace-Token header
 */
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { google } from "googleapis";

const PORT = parseInt(process.env.PORT ?? "3100", 10);
const INTERNAL_SECRET = process.env.INTERNAL_API_SECRET ?? "";

// ── Auth guard ────────────────────────────────────────────────────────────────

function checkSecret(req: express.Request, res: express.Response): string | null {
  if (req.headers["x-internal-secret"] !== INTERNAL_SECRET) {
    res.status(403).json({ error: "Forbidden" });
    return null;
  }
  const token = req.headers["x-workspace-token"] as string | undefined;
  if (!token) {
    res.status(401).json({ error: "No workspace token" });
    return null;
  }
  return token;
}

// ── GTM client factory ────────────────────────────────────────────────────────

function makeTagManager(accessToken: string) {
  const auth = new google.auth.OAuth2();
  auth.setCredentials({ access_token: accessToken });
  return google.tagmanager({ version: "v2", auth });
}

// ── Tool schemas (also served as OpenAI function-call JSON) ───────────────────

const TOOL_SCHEMAS = [
  {
    type: "function" as const,
    function: {
      name: "gtm_list_accounts",
      description: "Lists all Google Tag Manager accounts the connected token can access.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_get_account",
      description: "Gets a single GTM account by ID.",
      parameters: {
        type: "object",
        properties: { accountId: { type: "string", description: "GTM account ID" } },
        required: ["accountId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_update_account",
      description: "Updates settings for a GTM account. Only fields you provide will be changed.",
      parameters: {
        type: "object",
        properties: {
          accountId: { type: "string", description: "GTM account ID" },
          name:      { type: "string", description: "Display name of the account" },
          shareData: { type: "boolean", description: "Whether the account shares data anonymously with Google" },
        },
        required: ["accountId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_list_containers",
      description: "Lists all containers within a GTM account.",
      parameters: {
        type: "object",
        properties: { accountId: { type: "string", description: "GTM account ID" } },
        required: ["accountId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_get_container",
      description: "Gets a specific GTM container.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
        },
        required: ["accountId", "containerId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_create_container",
      description: "Creates a new GTM container in an account.",
      parameters: {
        type: "object",
        properties: {
          accountId:    { type: "string" },
          name:         { type: "string", description: "Container display name" },
          usageContext: { type: "array", items: { type: "string" }, description: "Usage contexts: 'web', 'android', 'ios', 'amp', 'server'" },
          domainName:   { type: "array", items: { type: "string" }, description: "Associated domain names" },
          notes:        { type: "string" },
        },
        required: ["accountId", "name", "usageContext"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_update_container",
      description: "Updates a GTM container. Only fields you provide will be changed.",
      parameters: {
        type: "object",
        properties: {
          accountId:    { type: "string" },
          containerId:  { type: "string" },
          name:         { type: "string" },
          domainName:   { type: "array", items: { type: "string" } },
          notes:        { type: "string" },
        },
        required: ["accountId", "containerId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_delete_container",
      description: "Deletes a GTM container. This is irreversible.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
        },
        required: ["accountId", "containerId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_combine_containers",
      description: "Combines (merges) a source GTM container into a destination container.",
      parameters: {
        type: "object",
        properties: {
          accountId:                        { type: "string", description: "Account ID owning both containers" },
          containerId:                      { type: "string", description: "Destination container ID" },
          sourceContainerId:                { type: "string", description: "Source container ID to merge from" },
          settingSource:                    { type: "string", description: "'current' to keep destination settings, 'other' to use source settings" },
          allowUserPermissionFeatureUpdate: { type: "boolean" },
        },
        required: ["accountId", "containerId", "sourceContainerId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_lookup_container",
      description: "Looks up a GTM container by destination link ID (e.g. GTM-XXXXXX, measurement ID) or tag ID.",
      parameters: {
        type: "object",
        properties: {
          accountId:     { type: "string" },
          destinationId: { type: "string", description: "Destination link ID (e.g. GTM-XXXXXX or GA measurement ID)" },
          tagId:         { type: "string", description: "Tag ID to look up" },
        },
        required: ["accountId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_move_tag_id",
      description: "Moves a tag ID from one GTM container to another.",
      parameters: {
        type: "object",
        properties: {
          accountId:                        { type: "string" },
          containerId:                      { type: "string", description: "Source container ID that currently owns the tag" },
          tagId:                            { type: "string", description: "Tag ID to move" },
          destinationContainerId:           { type: "string", description: "Target container ID to move the tag into" },
          copySettings:                     { type: "boolean", description: "Copy tag settings to the destination container" },
          allowUserPermissionFeatureUpdate: { type: "boolean" },
        },
        required: ["accountId", "containerId", "tagId", "destinationContainerId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_get_container_snippet",
      description: "Gets the GTM container snippet (the install code to embed on a page).",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
        },
        required: ["accountId", "containerId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_list_destinations",
      description: "Lists all destinations linked to a GTM container.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
        },
        required: ["accountId", "containerId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_get_destination",
      description: "Gets a specific destination linked to a GTM container.",
      parameters: {
        type: "object",
        properties: {
          accountId:     { type: "string" },
          containerId:   { type: "string" },
          destinationId: { type: "string", description: "Destination link ID" },
        },
        required: ["accountId", "containerId", "destinationId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_link_destination",
      description: "Links a destination (e.g. a measurement ID or GTM container public ID) to a GTM container.",
      parameters: {
        type: "object",
        properties: {
          accountId:                        { type: "string" },
          containerId:                      { type: "string" },
          destinationId:                    { type: "string", description: "Destination link ID to link (e.g. GTM-XXXXXX or measurement ID)" },
          allowUserPermissionFeatureUpdate: { type: "boolean" },
        },
        required: ["accountId", "containerId", "destinationId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_list_environments",
      description: "Lists all environments in a GTM container.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
        },
        required: ["accountId", "containerId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_get_environment",
      description: "Gets a specific GTM environment.",
      parameters: {
        type: "object",
        properties: {
          accountId:     { type: "string" },
          containerId:   { type: "string" },
          environmentId: { type: "string" },
        },
        required: ["accountId", "containerId", "environmentId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_create_environment",
      description: "Creates a new user environment in a GTM container.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          name:        { type: "string", description: "Environment display name" },
          description: { type: "string" },
          url:         { type: "string", description: "Default preview URL for this environment" },
          enableDebug: { type: "boolean", description: "Enable debug mode by default" },
        },
        required: ["accountId", "containerId", "name"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_update_environment",
      description: "Updates a GTM environment. Only fields you provide will be changed.",
      parameters: {
        type: "object",
        properties: {
          accountId:     { type: "string" },
          containerId:   { type: "string" },
          environmentId: { type: "string" },
          name:          { type: "string" },
          description:   { type: "string" },
          url:           { type: "string" },
          enableDebug:   { type: "boolean" },
        },
        required: ["accountId", "containerId", "environmentId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_delete_environment",
      description: "Deletes a user-created GTM environment.",
      parameters: {
        type: "object",
        properties: {
          accountId:     { type: "string" },
          containerId:   { type: "string" },
          environmentId: { type: "string" },
        },
        required: ["accountId", "containerId", "environmentId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_reauthorize_environment",
      description: "Re-generates the authorization code for a GTM environment.",
      parameters: {
        type: "object",
        properties: {
          accountId:     { type: "string" },
          containerId:   { type: "string" },
          environmentId: { type: "string" },
        },
        required: ["accountId", "containerId", "environmentId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_list_workspaces",
      description: "Lists all workspaces in a GTM container. Use this to find an editable workspace when the current one is locked/submitted.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
        },
        required: ["accountId", "containerId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_create_workspace",
      description: "Creates a new workspace in a GTM container. Useful when the current workspace is locked or submitted.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          name:        { type: "string", description: "Workspace name" },
          description: { type: "string" },
        },
        required: ["accountId", "containerId", "name"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_get_workspace",
      description: "Gets a specific GTM workspace.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
        },
        required: ["accountId", "containerId", "workspaceId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_update_workspace",
      description: "Updates a GTM workspace name or description.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
          name:        { type: "string" },
          description: { type: "string" },
        },
        required: ["accountId", "containerId", "workspaceId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_delete_workspace",
      description: "Deletes a GTM workspace.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
        },
        required: ["accountId", "containerId", "workspaceId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_get_workspace_status",
      description: "Gets the status of a GTM workspace, including pending changes and merge conflicts.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
        },
        required: ["accountId", "containerId", "workspaceId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_sync_workspace",
      description: "Syncs a GTM workspace to the latest container version, identifying any merge conflicts.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
        },
        required: ["accountId", "containerId", "workspaceId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_resolve_conflict",
      description: "Resolves a merge conflict in a GTM workspace by supplying the winning entity state.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
          fingerprint: { type: "string", description: "Fingerprint of the conflicting entity" },
          entity:      { type: "object", description: "The entity state to apply as the resolution (tag, trigger, variable, etc.)" },
        },
        required: ["accountId", "containerId", "workspaceId", "fingerprint", "entity"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_quick_preview",
      description: "Generates a quick preview link for a GTM workspace without creating a version.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
        },
        required: ["accountId", "containerId", "workspaceId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_create_version",
      description: "Creates a container version from a GTM workspace without publishing it. Use gtm_publish_version to create and publish in one step.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
          name:        { type: "string", description: "Version name" },
          notes:       { type: "string", description: "Version notes" },
        },
        required: ["accountId", "containerId", "workspaceId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_bulk_update",
      description: "Bulk creates, updates, or deletes entities (tags, triggers, variables, etc.) in a GTM workspace in a single call.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
          create:      { type: "array", items: { type: "object" }, description: "Entities to create" },
          update:      { type: "array", items: { type: "object" }, description: "Entities to update" },
          delete:      { type: "array", items: { type: "object" }, description: "Entities to delete" },
        },
        required: ["accountId", "containerId", "workspaceId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_list_tags",
      description: "Lists all tags in a GTM container workspace.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
        },
        required: ["accountId", "containerId", "workspaceId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_create_tag",
      description: "Creates a new tag in a GTM container workspace.",
      parameters: {
        type: "object",
        properties: {
          accountId:        { type: "string" },
          containerId:      { type: "string" },
          workspaceId:      { type: "string" },
          name:             { type: "string" },
          type:             { type: "string", description: "GTM tag type identifier. Common values: 'gaawc' (GA4 Configuration), 'gaawe' (GA4 Event), 'ua' (Universal Analytics), 'googtag' (Google tag / gtag.js), 'html' (Custom HTML), 'img' (Custom Image), 'awct' (Google Ads Conversion), 'flc' (Floodlight Counter), 'fls' (Floodlight Sales). Do NOT use plain names like 'google_analytics'." },
          tagFiringOption:  { type: "string", description: "When the tag fires: 'oncePerEvent' (default), 'oncePerLoad', or 'unlimited'." },
          firingTriggerId:  { type: "array", items: { type: "string" } },
          parameter:        { type: "array", items: { type: "object" }, description: "Tag parameters as GTM parameter objects with 'type', 'key', 'value' fields. For 'gaawc' (GA4 Config): [{type:'template',key:'measurementId',value:'G-XXXXXXXX'}]. For 'gaawe' (GA4 Event): [{type:'template',key:'eventName',value:'page_view'},{type:'template',key:'measurementId',value:'G-XXXXXXXX'}]. For 'googtag': [{type:'template',key:'gtmOnSuccess',value:''}]. IMPORTANT: Never hard-code a measurement ID. Always call ga4_get_measurement_id first to look up the G-XXXXXXXXXX measurement ID for the target property." },
        },
        required: ["accountId", "containerId", "workspaceId", "name", "type"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_update_tag",
      description: "Updates an existing tag in a GTM container workspace. Use gtm_list_tags first to get the tagId. Only fields you provide will be changed.",
      parameters: {
        type: "object",
        properties: {
          accountId:       { type: "string" },
          containerId:     { type: "string" },
          workspaceId:     { type: "string" },
          tagId:           { type: "string", description: "Numeric tag ID from gtm_list_tags" },
          name:            { type: "string" },
          tagFiringOption: { type: "string", description: "'oncePerEvent', 'oncePerLoad', or 'unlimited'" },
          firingTriggerId: { type: "array", items: { type: "string" }, description: "Full list of trigger IDs that should fire this tag (replaces existing list)" },
          parameter:       { type: "array", items: { type: "object" }, description: "Tag parameters as GTM parameter objects with 'type', 'key', 'value' fields (replaces existing parameters)" },
        },
        required: ["accountId", "containerId", "workspaceId", "tagId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_get_tag",
      description: "Gets a specific tag in a GTM workspace.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
          tagId:       { type: "string" },
        },
        required: ["accountId", "containerId", "workspaceId", "tagId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_delete_tag",
      description: "Deletes a tag from a GTM workspace.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
          tagId:       { type: "string" },
        },
        required: ["accountId", "containerId", "workspaceId", "tagId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_revert_tag",
      description: "Reverts a tag in a GTM workspace to its last published state.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
          tagId:       { type: "string" },
          fingerprint: { type: "string", description: "Optional fingerprint to verify the current state before reverting" },
        },
        required: ["accountId", "containerId", "workspaceId", "tagId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_list_triggers",
      description: "Lists all triggers in a GTM container workspace.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
        },
        required: ["accountId", "containerId", "workspaceId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_create_trigger",
      description: "Creates a new trigger in a GTM container workspace. Common types: pageview, click, customEvent, domReady, windowLoaded.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
          name:        { type: "string" },
          type:        { type: "string", description: "Trigger type: pageview, click, customEvent, domReady, windowLoaded, etc." },
          filter:      { type: "array", items: { type: "object" }, description: "Optional trigger filters" },
        },
        required: ["accountId", "containerId", "workspaceId", "name", "type"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_update_trigger",
      description: "Updates an existing trigger in a GTM container workspace. Use gtm_list_triggers first to get the triggerId. NOTE: tags reference triggers (not the reverse) — to attach a tag to a trigger, use gtm_update_tag and add the triggerId to firingTriggerId.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
          triggerId:   { type: "string", description: "Numeric trigger ID from gtm_list_triggers" },
          name:        { type: "string" },
          type:        { type: "string", description: "Trigger type: pageview, click, customEvent, domReady, windowLoaded, etc." },
          filter:      { type: "array", items: { type: "object" }, description: "Trigger filters (replaces existing filters)" },
        },
        required: ["accountId", "containerId", "workspaceId", "triggerId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_get_trigger",
      description: "Gets a specific trigger in a GTM workspace.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
          triggerId:   { type: "string" },
        },
        required: ["accountId", "containerId", "workspaceId", "triggerId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_delete_trigger",
      description: "Deletes a trigger from a GTM workspace.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
          triggerId:   { type: "string" },
        },
        required: ["accountId", "containerId", "workspaceId", "triggerId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_revert_trigger",
      description: "Reverts a trigger in a GTM workspace to its last published state.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
          triggerId:   { type: "string" },
          fingerprint: { type: "string", description: "Optional fingerprint to verify the current state before reverting" },
        },
        required: ["accountId", "containerId", "workspaceId", "triggerId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_list_variables",
      description: "Lists all variables in a GTM workspace.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
        },
        required: ["accountId", "containerId", "workspaceId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_get_variable",
      description: "Gets a specific variable in a GTM workspace.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
          variableId:  { type: "string" },
        },
        required: ["accountId", "containerId", "workspaceId", "variableId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_create_variable",
      description: "Creates a new variable in a GTM workspace. Common types: 'v' (Data Layer), 'k' (1st Party Cookie), 'u' (URL), 'c' (Constant), 'jsm' (Custom JavaScript), 'e' (DOM Element), 'f' (HTTP Referrer), 'r' (Random Number).",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
          name:        { type: "string" },
          type:        { type: "string", description: "Variable type identifier, e.g. 'v', 'k', 'u', 'c', 'jsm'" },
          parameter:   { type: "array", items: { type: "object" }, description: "Variable parameters as GTM parameter objects with 'type', 'key', 'value' fields" },
        },
        required: ["accountId", "containerId", "workspaceId", "name", "type"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_update_variable",
      description: "Updates an existing variable in a GTM workspace. Only fields you provide will be changed.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
          variableId:  { type: "string" },
          name:        { type: "string" },
          parameter:   { type: "array", items: { type: "object" }, description: "Variable parameters (replaces existing)" },
        },
        required: ["accountId", "containerId", "workspaceId", "variableId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_delete_variable",
      description: "Deletes a variable from a GTM workspace.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
          variableId:  { type: "string" },
        },
        required: ["accountId", "containerId", "workspaceId", "variableId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_revert_variable",
      description: "Reverts a variable in a GTM workspace to its last published state.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
          variableId:  { type: "string" },
          fingerprint: { type: "string", description: "Optional fingerprint to verify the current state before reverting" },
        },
        required: ["accountId", "containerId", "workspaceId", "variableId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_list_built_in_variables",
      description: "Lists all enabled built-in variables in a GTM workspace.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
        },
        required: ["accountId", "containerId", "workspaceId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_create_built_in_variable",
      description: "Enables one or more built-in variables in a GTM workspace. Common types: pageUrl, pageHostname, pagePath, referrer, event, clickElement, clickClasses, clickId, clickTarget, clickUrl, clickText, formElement, formClasses, formId, formTarget, formUrl, formText, errorMessage, errorUrl, errorLine, randomNumber, containerId, containerVersion, debugMode, environmentName.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
          type:        { type: "array", items: { type: "string" }, description: "Built-in variable type(s) to enable" },
        },
        required: ["accountId", "containerId", "workspaceId", "type"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_delete_built_in_variable",
      description: "Disables a built-in variable in a GTM workspace.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
          type:        { type: "string", description: "Built-in variable type to disable" },
        },
        required: ["accountId", "containerId", "workspaceId", "type"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_revert_built_in_variable",
      description: "Reverts a built-in variable in a GTM workspace to its last published state.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
          type:        { type: "string", description: "Built-in variable type to revert" },
        },
        required: ["accountId", "containerId", "workspaceId", "type"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_list_folders",
      description: "Lists all folders in a GTM workspace.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
        },
        required: ["accountId", "containerId", "workspaceId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_get_folder",
      description: "Gets a specific folder in a GTM workspace.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
          folderId:    { type: "string" },
        },
        required: ["accountId", "containerId", "workspaceId", "folderId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_create_folder",
      description: "Creates a new folder in a GTM workspace.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
          name:        { type: "string" },
          notes:       { type: "string" },
        },
        required: ["accountId", "containerId", "workspaceId", "name"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_update_folder",
      description: "Updates a folder in a GTM workspace. Only fields you provide will be changed.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
          folderId:    { type: "string" },
          name:        { type: "string" },
          notes:       { type: "string" },
        },
        required: ["accountId", "containerId", "workspaceId", "folderId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_delete_folder",
      description: "Deletes a folder from a GTM workspace.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
          folderId:    { type: "string" },
        },
        required: ["accountId", "containerId", "workspaceId", "folderId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_list_folder_entities",
      description: "Lists all tags, triggers, and variables contained in a GTM folder.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
          folderId:    { type: "string" },
          pageToken:   { type: "string", description: "Pagination token for next page" },
        },
        required: ["accountId", "containerId", "workspaceId", "folderId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_move_entities_to_folder",
      description: "Moves tags, triggers, and/or variables into a GTM folder.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
          folderId:    { type: "string", description: "Destination folder ID" },
          tagId:       { type: "array", items: { type: "string" }, description: "Tag IDs to move" },
          triggerId:   { type: "array", items: { type: "string" }, description: "Trigger IDs to move" },
          variableId:  { type: "array", items: { type: "string" }, description: "Variable IDs to move" },
        },
        required: ["accountId", "containerId", "workspaceId", "folderId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_revert_folder",
      description: "Reverts a folder in a GTM workspace to its last published state.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
          folderId:    { type: "string" },
          fingerprint: { type: "string", description: "Optional fingerprint to verify the current state before reverting" },
        },
        required: ["accountId", "containerId", "workspaceId", "folderId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_list_templates",
      description: "Lists all custom templates in a GTM workspace.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
        },
        required: ["accountId", "containerId", "workspaceId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_get_template",
      description: "Gets a specific custom template in a GTM workspace.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
          templateId:  { type: "string" },
        },
        required: ["accountId", "containerId", "workspaceId", "templateId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_create_template",
      description: "Creates a custom template in a GTM workspace from raw template data.",
      parameters: {
        type: "object",
        properties: {
          accountId:    { type: "string" },
          containerId:  { type: "string" },
          workspaceId:  { type: "string" },
          name:         { type: "string" },
          templateData: { type: "string", description: "The template source code (Sandboxed JS / fields config)" },
        },
        required: ["accountId", "containerId", "workspaceId", "name", "templateData"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_update_template",
      description: "Updates a custom template in a GTM workspace. Only fields you provide will be changed.",
      parameters: {
        type: "object",
        properties: {
          accountId:    { type: "string" },
          containerId:  { type: "string" },
          workspaceId:  { type: "string" },
          templateId:   { type: "string" },
          name:         { type: "string" },
          templateData: { type: "string" },
        },
        required: ["accountId", "containerId", "workspaceId", "templateId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_delete_template",
      description: "Deletes a custom template from a GTM workspace.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
          templateId:  { type: "string" },
        },
        required: ["accountId", "containerId", "workspaceId", "templateId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_revert_template",
      description: "Reverts a custom template in a GTM workspace to its last published state.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
          templateId:  { type: "string" },
          fingerprint: { type: "string", description: "Optional fingerprint to verify the current state before reverting" },
        },
        required: ["accountId", "containerId", "workspaceId", "templateId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_import_template_from_gallery",
      description: "Imports a template from the GTM Community Template Gallery into a workspace.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
          owner:       { type: "string", description: "GitHub repository owner" },
          repository:  { type: "string", description: "GitHub repository name" },
          version:     { type: "string", description: "Version tag or commit SHA (omit for latest)" },
          host:        { type: "string", description: "Gallery host, defaults to 'github.com'" },
        },
        required: ["accountId", "containerId", "workspaceId", "owner", "repository"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_list_transformations",
      description: "Lists all transformations in a GTM workspace (server containers).",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
        },
        required: ["accountId", "containerId", "workspaceId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_get_transformation",
      description: "Gets a specific transformation in a GTM workspace.",
      parameters: {
        type: "object",
        properties: {
          accountId:        { type: "string" },
          containerId:      { type: "string" },
          workspaceId:      { type: "string" },
          transformationId: { type: "string" },
        },
        required: ["accountId", "containerId", "workspaceId", "transformationId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_create_transformation",
      description: "Creates a transformation in a GTM workspace.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
          name:        { type: "string" },
          type:        { type: "string", description: "Transformation type identifier" },
          parameter:   { type: "array", items: { type: "object" }, description: "Transformation parameters as GTM parameter objects with 'type', 'key', 'value' fields" },
        },
        required: ["accountId", "containerId", "workspaceId", "name", "type"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_update_transformation",
      description: "Updates a transformation in a GTM workspace. Only fields you provide will be changed.",
      parameters: {
        type: "object",
        properties: {
          accountId:        { type: "string" },
          containerId:      { type: "string" },
          workspaceId:      { type: "string" },
          transformationId: { type: "string" },
          name:             { type: "string" },
          parameter:        { type: "array", items: { type: "object" }, description: "Transformation parameters (replaces existing)" },
        },
        required: ["accountId", "containerId", "workspaceId", "transformationId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_delete_transformation",
      description: "Deletes a transformation from a GTM workspace.",
      parameters: {
        type: "object",
        properties: {
          accountId:        { type: "string" },
          containerId:      { type: "string" },
          workspaceId:      { type: "string" },
          transformationId: { type: "string" },
        },
        required: ["accountId", "containerId", "workspaceId", "transformationId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_revert_transformation",
      description: "Reverts a transformation in a GTM workspace to its last published state.",
      parameters: {
        type: "object",
        properties: {
          accountId:        { type: "string" },
          containerId:      { type: "string" },
          workspaceId:      { type: "string" },
          transformationId: { type: "string" },
          fingerprint:      { type: "string", description: "Optional fingerprint to verify the current state before reverting" },
        },
        required: ["accountId", "containerId", "workspaceId", "transformationId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_list_clients",
      description: "Lists all clients in a GTM workspace (server-side containers).",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
        },
        required: ["accountId", "containerId", "workspaceId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_get_client",
      description: "Gets a specific client in a GTM workspace.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
          clientId:    { type: "string" },
        },
        required: ["accountId", "containerId", "workspaceId", "clientId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_create_client",
      description: "Creates a client in a GTM workspace (server-side containers).",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
          name:        { type: "string" },
          type:        { type: "string", description: "Client type identifier" },
          parameter:   { type: "array", items: { type: "object" }, description: "Client parameters as GTM parameter objects with 'type', 'key', 'value' fields" },
        },
        required: ["accountId", "containerId", "workspaceId", "name", "type"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_update_client",
      description: "Updates a client in a GTM workspace. Only fields you provide will be changed.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
          clientId:    { type: "string" },
          name:        { type: "string" },
          parameter:   { type: "array", items: { type: "object" }, description: "Client parameters (replaces existing)" },
        },
        required: ["accountId", "containerId", "workspaceId", "clientId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_delete_client",
      description: "Deletes a client from a GTM workspace.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
          clientId:    { type: "string" },
        },
        required: ["accountId", "containerId", "workspaceId", "clientId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_revert_client",
      description: "Reverts a client in a GTM workspace to its last published state.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
          clientId:    { type: "string" },
          fingerprint: { type: "string", description: "Optional fingerprint to verify the current state before reverting" },
        },
        required: ["accountId", "containerId", "workspaceId", "clientId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_list_zones",
      description: "Lists all zones in a GTM workspace (web containers).",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
        },
        required: ["accountId", "containerId", "workspaceId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_get_zone",
      description: "Gets a specific zone in a GTM workspace.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
          zoneId:      { type: "string" },
        },
        required: ["accountId", "containerId", "workspaceId", "zoneId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_create_zone",
      description: "Creates a zone in a GTM workspace (web containers). Zones define page regions with optional tag-type restrictions and boundary conditions.",
      parameters: {
        type: "object",
        properties: {
          accountId:       { type: "string" },
          containerId:     { type: "string" },
          workspaceId:     { type: "string" },
          name:            { type: "string" },
          notes:           { type: "string" },
          boundary:        { type: "object", description: "Zone boundary conditions with 'condition' array and optional 'customEvaluationTriggerId' array" },
          typeRestriction: { type: "object", description: "Tag type restriction with 'enable' boolean and 'whitelistedTypeId' string array" },
          childContainer:  { type: "array", items: { type: "object" }, description: "Child container references" },
        },
        required: ["accountId", "containerId", "workspaceId", "name"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_update_zone",
      description: "Updates a zone in a GTM workspace. Only fields you provide will be changed.",
      parameters: {
        type: "object",
        properties: {
          accountId:       { type: "string" },
          containerId:     { type: "string" },
          workspaceId:     { type: "string" },
          zoneId:          { type: "string" },
          name:            { type: "string" },
          notes:           { type: "string" },
          boundary:        { type: "object" },
          typeRestriction: { type: "object" },
          childContainer:  { type: "array", items: { type: "object" } },
        },
        required: ["accountId", "containerId", "workspaceId", "zoneId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_delete_zone",
      description: "Deletes a zone from a GTM workspace.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
          zoneId:      { type: "string" },
        },
        required: ["accountId", "containerId", "workspaceId", "zoneId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_revert_zone",
      description: "Reverts a zone in a GTM workspace to its last published state.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
          zoneId:      { type: "string" },
          fingerprint: { type: "string", description: "Optional fingerprint to verify the current state before reverting" },
        },
        required: ["accountId", "containerId", "workspaceId", "zoneId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_list_gtag_configs",
      description: "Lists all gtag configurations in a GTM workspace.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
        },
        required: ["accountId", "containerId", "workspaceId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_get_gtag_config",
      description: "Gets a specific gtag configuration in a GTM workspace.",
      parameters: {
        type: "object",
        properties: {
          accountId:    { type: "string" },
          containerId:  { type: "string" },
          workspaceId:  { type: "string" },
          gtagConfigId: { type: "string" },
        },
        required: ["accountId", "containerId", "workspaceId", "gtagConfigId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_create_gtag_config",
      description: "Creates a gtag configuration in a GTM workspace. Common types: 'GA4' (Google Analytics 4), 'AW' (Google Ads), 'DC' (Display & Video 360), 'GT' (Google tag).",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
          type:        { type: "string", description: "GTag config type: 'GA4', 'AW', 'DC', 'GT'" },
          parameter:   { type: "array", items: { type: "object" }, description: "Config parameters as GTM parameter objects with 'type', 'key', 'value' fields" },
        },
        required: ["accountId", "containerId", "workspaceId", "type"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_update_gtag_config",
      description: "Updates a gtag configuration in a GTM workspace. Only fields you provide will be changed.",
      parameters: {
        type: "object",
        properties: {
          accountId:    { type: "string" },
          containerId:  { type: "string" },
          workspaceId:  { type: "string" },
          gtagConfigId: { type: "string" },
          parameter:    { type: "array", items: { type: "object" }, description: "Config parameters (replaces existing)" },
        },
        required: ["accountId", "containerId", "workspaceId", "gtagConfigId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_delete_gtag_config",
      description: "Deletes a gtag configuration from a GTM workspace.",
      parameters: {
        type: "object",
        properties: {
          accountId:    { type: "string" },
          containerId:  { type: "string" },
          workspaceId:  { type: "string" },
          gtagConfigId: { type: "string" },
        },
        required: ["accountId", "containerId", "workspaceId", "gtagConfigId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_list_user_permissions",
      description: "Lists all user permissions on a GTM account.",
      parameters: {
        type: "object",
        properties: {
          accountId: { type: "string" },
        },
        required: ["accountId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_get_user_permission",
      description: "Gets a specific user's permissions on a GTM account.",
      parameters: {
        type: "object",
        properties: {
          accountId:          { type: "string" },
          userPermissionId:   { type: "string", description: "User permission ID (typically the user's email address)" },
        },
        required: ["accountId", "userPermissionId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_create_user_permission",
      description: "Grants a user access to a GTM account. Account-level permission values: 'read', 'editWorkspace', 'approve', 'publish', 'noAccess'.",
      parameters: {
        type: "object",
        properties: {
          accountId:       { type: "string" },
          emailAddress:    { type: "string", description: "User's email address" },
          accountAccess:   { type: "object", description: "Account-level access: { permission: 'read' | 'editWorkspace' | 'approve' | 'publish' | 'noAccess' }" },
          containerAccess: { type: "array", items: { type: "object" }, description: "Per-container access overrides: [{ containerId, permission }]" },
        },
        required: ["accountId", "emailAddress", "accountAccess"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_update_user_permission",
      description: "Updates a user's access level on a GTM account. Only fields you provide will be changed.",
      parameters: {
        type: "object",
        properties: {
          accountId:        { type: "string" },
          userPermissionId: { type: "string", description: "User permission ID (typically the user's email address)" },
          accountAccess:    { type: "object", description: "Account-level access: { permission: 'read' | 'editWorkspace' | 'approve' | 'publish' | 'noAccess' }" },
          containerAccess:  { type: "array", items: { type: "object" }, description: "Per-container access overrides: [{ containerId, permission }] (replaces existing)" },
        },
        required: ["accountId", "userPermissionId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_delete_user_permission",
      description: "Revokes a user's access to a GTM account.",
      parameters: {
        type: "object",
        properties: {
          accountId:        { type: "string" },
          userPermissionId: { type: "string", description: "User permission ID (typically the user's email address)" },
        },
        required: ["accountId", "userPermissionId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_list_versions",
      description: "Lists container versions for a GTM container.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
        },
        required: ["accountId", "containerId"],
      },
    },
  },
  {
    type: "function" as const,
    function: {
      name: "gtm_publish_version",
      description: "Creates and publishes a new container version in GTM.",
      parameters: {
        type: "object",
        properties: {
          accountId:   { type: "string" },
          containerId: { type: "string" },
          workspaceId: { type: "string" },
          name:        { type: "string" },
          notes:       { type: "string" },
        },
        required: ["accountId", "containerId", "workspaceId"],
      },
    },
  },
];

// ── MCP server builder ────────────────────────────────────────────────────────

function buildMcpServer(accessToken: string): McpServer {
  const server = new McpServer({ name: "gtm-mcp", version: "1.0.0" });
  const tagmanager = makeTagManager(accessToken);

  server.tool("gtm_list_accounts", {}, async () => {
    const res = await tagmanager.accounts.list();
    return { content: [{ type: "text", text: JSON.stringify(res.data.account ?? []) }] };
  });

  server.tool("gtm_get_account", { accountId: z.string() }, async ({ accountId }) => {
    const res = await tagmanager.accounts.get({ path: `accounts/${accountId}` });
    return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
  });

  server.tool(
    "gtm_update_account",
    { accountId: z.string(), name: z.string().optional(), shareData: z.boolean().optional() },
    async ({ accountId, name, shareData }) => {
      const path = `accounts/${accountId}`;
      const existing = await tagmanager.accounts.get({ path });
      const current = existing.data as Record<string, unknown>;
      const res = await tagmanager.accounts.update({
        path,
        requestBody: {
          ...current,
          ...(name      !== undefined ? { name }      : {}),
          ...(shareData !== undefined ? { shareData } : {}),
        } as never,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool("gtm_list_containers", { accountId: z.string() }, async ({ accountId }) => {
    const res = await tagmanager.accounts.containers.list({ parent: `accounts/${accountId}` });
    return { content: [{ type: "text", text: JSON.stringify(res.data.container ?? []) }] };
  });

  server.tool(
    "gtm_get_container",
    { accountId: z.string(), containerId: z.string() },
    async ({ accountId, containerId }) => {
      const res = await tagmanager.accounts.containers.get({
        path: `accounts/${accountId}/containers/${containerId}`,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_create_container",
    {
      accountId:    z.string(),
      name:         z.string(),
      usageContext: z.array(z.string()),
      domainName:   z.array(z.string()).optional(),
      notes:        z.string().optional(),
    },
    async ({ accountId, name, usageContext, domainName, notes }) => {
      const res = await tagmanager.accounts.containers.create({
        parent: `accounts/${accountId}`,
        requestBody: { name, usageContext, domainName, notes } as never,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_update_container",
    {
      accountId:   z.string(),
      containerId: z.string(),
      name:        z.string().optional(),
      domainName:  z.array(z.string()).optional(),
      notes:       z.string().optional(),
    },
    async ({ accountId, containerId, name, domainName, notes }) => {
      const path = `accounts/${accountId}/containers/${containerId}`;
      const existing = await tagmanager.accounts.containers.get({ path });
      const current = existing.data as Record<string, unknown>;
      const res = await tagmanager.accounts.containers.update({
        path,
        requestBody: {
          ...current,
          ...(name       !== undefined ? { name }       : {}),
          ...(domainName !== undefined ? { domainName } : {}),
          ...(notes      !== undefined ? { notes }      : {}),
        } as never,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_delete_container",
    { accountId: z.string(), containerId: z.string() },
    async ({ accountId, containerId }) => {
      await tagmanager.accounts.containers.delete({
        path: `accounts/${accountId}/containers/${containerId}`,
      });
      return { content: [{ type: "text", text: JSON.stringify({ deleted: true }) }] };
    },
  );

  server.tool(
    "gtm_combine_containers",
    {
      accountId:                        z.string(),
      containerId:                      z.string(),
      sourceContainerId:                z.string(),
      settingSource:                    z.string().optional(),
      allowUserPermissionFeatureUpdate: z.boolean().optional(),
    },
    async ({ accountId, containerId, sourceContainerId, settingSource, allowUserPermissionFeatureUpdate }) => {
      const res = await tagmanager.accounts.containers.combine({
        path:                            `accounts/${accountId}/containers/${containerId}`,
        containerId:                     sourceContainerId,
        settingSource:                   settingSource as never,
        allowUserPermissionFeatureUpdate,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_lookup_container",
    {
      accountId:     z.string(),
      destinationId: z.string().optional(),
      tagId:         z.string().optional(),
    },
    async ({ accountId, destinationId, tagId }) => {
      const res = await tagmanager.accounts.containers.lookup({
        parent:        `accounts/${accountId}`,
        destinationId,
        tagId,
      } as never);
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_move_tag_id",
    {
      accountId:                        z.string(),
      containerId:                      z.string(),
      tagId:                            z.string(),
      destinationContainerId:           z.string(),
      copySettings:                     z.boolean().optional(),
      allowUserPermissionFeatureUpdate: z.boolean().optional(),
    },
    async ({ accountId, containerId, tagId, destinationContainerId, copySettings, allowUserPermissionFeatureUpdate }) => {
      const res = await tagmanager.accounts.containers.move_tag_id({
        path:                            `accounts/${accountId}/containers/${containerId}`,
        tagId,
        destinationContainerId,
        copySettings,
        allowUserPermissionFeatureUpdate,
      } as never);
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_get_container_snippet",
    { accountId: z.string(), containerId: z.string() },
    async ({ accountId, containerId }) => {
      const res = await tagmanager.accounts.containers.snippet({
        path: `accounts/${accountId}/containers/${containerId}`,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_list_destinations",
    { accountId: z.string(), containerId: z.string() },
    async ({ accountId, containerId }) => {
      const res = await tagmanager.accounts.containers.destinations.list({
        parent: `accounts/${accountId}/containers/${containerId}`,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data.destination ?? []) }] };
    },
  );

  server.tool(
    "gtm_get_destination",
    { accountId: z.string(), containerId: z.string(), destinationId: z.string() },
    async ({ accountId, containerId, destinationId }) => {
      const res = await tagmanager.accounts.containers.destinations.get({
        path: `accounts/${accountId}/containers/${containerId}/destinations/${destinationId}`,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_link_destination",
    {
      accountId:                        z.string(),
      containerId:                      z.string(),
      destinationId:                    z.string(),
      allowUserPermissionFeatureUpdate: z.boolean().optional(),
    },
    async ({ accountId, containerId, destinationId, allowUserPermissionFeatureUpdate }) => {
      const res = await tagmanager.accounts.containers.destinations.link({
        parent:                          `accounts/${accountId}/containers/${containerId}`,
        destinationId,
        allowUserPermissionFeatureUpdate,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_list_environments",
    { accountId: z.string(), containerId: z.string() },
    async ({ accountId, containerId }) => {
      const res = await tagmanager.accounts.containers.environments.list({
        parent: `accounts/${accountId}/containers/${containerId}`,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data.environment ?? []) }] };
    },
  );

  server.tool(
    "gtm_get_environment",
    { accountId: z.string(), containerId: z.string(), environmentId: z.string() },
    async ({ accountId, containerId, environmentId }) => {
      const res = await tagmanager.accounts.containers.environments.get({
        path: `accounts/${accountId}/containers/${containerId}/environments/${environmentId}`,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_create_environment",
    {
      accountId:   z.string(),
      containerId: z.string(),
      name:        z.string(),
      description: z.string().optional(),
      url:         z.string().optional(),
      enableDebug: z.boolean().optional(),
    },
    async ({ accountId, containerId, name, description, url, enableDebug }) => {
      const res = await tagmanager.accounts.containers.environments.create({
        parent: `accounts/${accountId}/containers/${containerId}`,
        requestBody: { name, type: "user", description, url, enableDebug } as never,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_update_environment",
    {
      accountId:     z.string(),
      containerId:   z.string(),
      environmentId: z.string(),
      name:          z.string().optional(),
      description:   z.string().optional(),
      url:           z.string().optional(),
      enableDebug:   z.boolean().optional(),
    },
    async ({ accountId, containerId, environmentId, name, description, url, enableDebug }) => {
      const path = `accounts/${accountId}/containers/${containerId}/environments/${environmentId}`;
      const existing = await tagmanager.accounts.containers.environments.get({ path });
      const current = existing.data as Record<string, unknown>;
      const res = await tagmanager.accounts.containers.environments.update({
        path,
        requestBody: {
          ...current,
          ...(name        !== undefined ? { name }        : {}),
          ...(description !== undefined ? { description } : {}),
          ...(url         !== undefined ? { url }         : {}),
          ...(enableDebug !== undefined ? { enableDebug } : {}),
        } as never,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_delete_environment",
    { accountId: z.string(), containerId: z.string(), environmentId: z.string() },
    async ({ accountId, containerId, environmentId }) => {
      await tagmanager.accounts.containers.environments.delete({
        path: `accounts/${accountId}/containers/${containerId}/environments/${environmentId}`,
      });
      return { content: [{ type: "text", text: JSON.stringify({ deleted: true }) }] };
    },
  );

  server.tool(
    "gtm_reauthorize_environment",
    { accountId: z.string(), containerId: z.string(), environmentId: z.string() },
    async ({ accountId, containerId, environmentId }) => {
      const path = `accounts/${accountId}/containers/${containerId}/environments/${environmentId}`;
      const existing = await tagmanager.accounts.containers.environments.get({ path });
      const res = await tagmanager.accounts.containers.environments.reauthorize({
        path,
        requestBody: existing.data as never,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_list_workspaces",
    { accountId: z.string(), containerId: z.string() },
    async ({ accountId, containerId }) => {
      const res = await tagmanager.accounts.containers.workspaces.list({
        parent: `accounts/${accountId}/containers/${containerId}`,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data.workspace ?? []) }] };
    },
  );

  server.tool(
    "gtm_create_workspace",
    {
      accountId: z.string(), containerId: z.string(),
      name: z.string(), description: z.string().optional(),
    },
    async ({ accountId, containerId, name, description }) => {
      const res = await tagmanager.accounts.containers.workspaces.create({
        parent: `accounts/${accountId}/containers/${containerId}`,
        requestBody: { name, description } as never,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_get_workspace",
    { accountId: z.string(), containerId: z.string(), workspaceId: z.string() },
    async ({ accountId, containerId, workspaceId }) => {
      const res = await tagmanager.accounts.containers.workspaces.get({
        path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_update_workspace",
    {
      accountId:   z.string(),
      containerId: z.string(),
      workspaceId: z.string(),
      name:        z.string().optional(),
      description: z.string().optional(),
    },
    async ({ accountId, containerId, workspaceId, name, description }) => {
      const path = `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`;
      const existing = await tagmanager.accounts.containers.workspaces.get({ path });
      const current = existing.data as Record<string, unknown>;
      const res = await tagmanager.accounts.containers.workspaces.update({
        path,
        requestBody: {
          ...current,
          ...(name        !== undefined ? { name }        : {}),
          ...(description !== undefined ? { description } : {}),
        } as never,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_delete_workspace",
    { accountId: z.string(), containerId: z.string(), workspaceId: z.string() },
    async ({ accountId, containerId, workspaceId }) => {
      await tagmanager.accounts.containers.workspaces.delete({
        path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
      });
      return { content: [{ type: "text", text: JSON.stringify({ deleted: true }) }] };
    },
  );

  server.tool(
    "gtm_get_workspace_status",
    { accountId: z.string(), containerId: z.string(), workspaceId: z.string() },
    async ({ accountId, containerId, workspaceId }) => {
      const res = await tagmanager.accounts.containers.workspaces.getStatus({
        path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_sync_workspace",
    { accountId: z.string(), containerId: z.string(), workspaceId: z.string() },
    async ({ accountId, containerId, workspaceId }) => {
      const res = await tagmanager.accounts.containers.workspaces.sync({
        path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_resolve_conflict",
    {
      accountId:   z.string(),
      containerId: z.string(),
      workspaceId: z.string(),
      fingerprint: z.string(),
      entity:      z.record(z.unknown()),
    },
    async ({ accountId, containerId, workspaceId, fingerprint, entity }) => {
      await tagmanager.accounts.containers.workspaces.resolve_conflict({
        path:        `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
        fingerprint,
        requestBody: entity as never,
      });
      return { content: [{ type: "text", text: JSON.stringify({ resolved: true }) }] };
    },
  );

  server.tool(
    "gtm_quick_preview",
    { accountId: z.string(), containerId: z.string(), workspaceId: z.string() },
    async ({ accountId, containerId, workspaceId }) => {
      const res = await tagmanager.accounts.containers.workspaces.quick_preview({
        path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_create_version",
    {
      accountId:   z.string(),
      containerId: z.string(),
      workspaceId: z.string(),
      name:        z.string().optional(),
      notes:       z.string().optional(),
    },
    async ({ accountId, containerId, workspaceId, name, notes }) => {
      const res = await tagmanager.accounts.containers.workspaces.create_version({
        path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
        requestBody: { name, notes } as never,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_bulk_update",
    {
      accountId:   z.string(),
      containerId: z.string(),
      workspaceId: z.string(),
      create:      z.array(z.record(z.unknown())).optional(),
      update:      z.array(z.record(z.unknown())).optional(),
      delete:      z.array(z.record(z.unknown())).optional(),
    },
    async ({ accountId, containerId, workspaceId, create, update, delete: del }) => {
      const res = await tagmanager.accounts.containers.workspaces.bulk_entities_update({
        path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
        requestBody: { create, update, delete: del } as never,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_list_tags",
    { accountId: z.string(), containerId: z.string(), workspaceId: z.string() },
    async ({ accountId, containerId, workspaceId }) => {
      const res = await tagmanager.accounts.containers.workspaces.tags.list({
        parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data.tag ?? []) }] };
    },
  );

  server.tool(
    "gtm_create_tag",
    {
      accountId: z.string(), containerId: z.string(), workspaceId: z.string(),
      name: z.string(), type: z.string(),
      tagFiringOption: z.string().optional(),
      firingTriggerId: z.array(z.string()).optional(),
      parameter: z.array(z.record(z.unknown())).optional(),
    },
    async ({ accountId, containerId, workspaceId, name, type, tagFiringOption, firingTriggerId, parameter }) => {
      // Strip any extra fields from parameter items — GTM API only accepts type/key/value/list/map/isWeakReference
      const cleanParameter = parameter?.map((p) => ({
        type: p["type"], key: p["key"], value: p["value"],
        ...(p["list"]            ? { list: p["list"] }                       : {}),
        ...(p["map"]             ? { map: p["map"] }                         : {}),
        ...(p["isWeakReference"] !== undefined ? { isWeakReference: p["isWeakReference"] } : {}),
      }));
      const res = await tagmanager.accounts.containers.workspaces.tags.create({
        parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
        requestBody: { name, type, tagFiringOption, firingTriggerId, parameter: cleanParameter } as never,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_update_tag",
    {
      accountId: z.string(), containerId: z.string(), workspaceId: z.string(),
      tagId: z.string(),
      name: z.string().optional(),
      tagFiringOption: z.string().optional(),
      firingTriggerId: z.array(z.string()).optional(),
      parameter: z.array(z.record(z.unknown())).optional(),
    },
    async ({ accountId, containerId, workspaceId, tagId, name, tagFiringOption, firingTriggerId, parameter }) => {
      const path = `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/tags/${tagId}`;
      const existing = await tagmanager.accounts.containers.workspaces.tags.get({ path });
      const current = existing.data as Record<string, unknown>;
      const cleanParameter = parameter?.map((p) => ({
        type: p["type"], key: p["key"], value: p["value"],
        ...(p["list"]            ? { list: p["list"] }                       : {}),
        ...(p["map"]             ? { map: p["map"] }                         : {}),
        ...(p["isWeakReference"] !== undefined ? { isWeakReference: p["isWeakReference"] } : {}),
      }));
      const res = await tagmanager.accounts.containers.workspaces.tags.update({
        path,
        requestBody: {
          ...current,
          ...(name            !== undefined ? { name }            : {}),
          ...(tagFiringOption !== undefined ? { tagFiringOption } : {}),
          ...(firingTriggerId !== undefined ? { firingTriggerId } : {}),
          ...(cleanParameter  !== undefined ? { parameter: cleanParameter } : {}),
        } as never,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_get_tag",
    { accountId: z.string(), containerId: z.string(), workspaceId: z.string(), tagId: z.string() },
    async ({ accountId, containerId, workspaceId, tagId }) => {
      const res = await tagmanager.accounts.containers.workspaces.tags.get({
        path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/tags/${tagId}`,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_delete_tag",
    { accountId: z.string(), containerId: z.string(), workspaceId: z.string(), tagId: z.string() },
    async ({ accountId, containerId, workspaceId, tagId }) => {
      await tagmanager.accounts.containers.workspaces.tags.delete({
        path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/tags/${tagId}`,
      });
      return { content: [{ type: "text", text: JSON.stringify({ deleted: true }) }] };
    },
  );

  server.tool(
    "gtm_revert_tag",
    {
      accountId:   z.string(),
      containerId: z.string(),
      workspaceId: z.string(),
      tagId:       z.string(),
      fingerprint: z.string().optional(),
    },
    async ({ accountId, containerId, workspaceId, tagId, fingerprint }) => {
      const res = await tagmanager.accounts.containers.workspaces.tags.revert({
        path:        `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/tags/${tagId}`,
        fingerprint,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_list_triggers",
    { accountId: z.string(), containerId: z.string(), workspaceId: z.string() },
    async ({ accountId, containerId, workspaceId }) => {
      const res = await tagmanager.accounts.containers.workspaces.triggers.list({
        parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data.trigger ?? []) }] };
    },
  );

  server.tool(
    "gtm_create_trigger",
    {
      accountId: z.string(), containerId: z.string(), workspaceId: z.string(),
      name: z.string(), type: z.string(),
      filter: z.array(z.record(z.unknown())).optional(),
    },
    async ({ accountId, containerId, workspaceId, name, type, filter }) => {
      const res = await tagmanager.accounts.containers.workspaces.triggers.create({
        parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
        requestBody: { name, type, filter } as never,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_update_trigger",
    {
      accountId: z.string(), containerId: z.string(), workspaceId: z.string(),
      triggerId: z.string(),
      name: z.string().optional(),
      type: z.string().optional(),
      filter: z.array(z.record(z.unknown())).optional(),
    },
    async ({ accountId, containerId, workspaceId, triggerId, name, type, filter }) => {
      const path = `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/triggers/${triggerId}`;
      const existing = await tagmanager.accounts.containers.workspaces.triggers.get({ path });
      const current = existing.data as Record<string, unknown>;
      const res = await tagmanager.accounts.containers.workspaces.triggers.update({
        path,
        requestBody: {
          ...current,
          ...(name   !== undefined ? { name }   : {}),
          ...(type   !== undefined ? { type }   : {}),
          ...(filter !== undefined ? { filter } : {}),
        } as never,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_get_trigger",
    { accountId: z.string(), containerId: z.string(), workspaceId: z.string(), triggerId: z.string() },
    async ({ accountId, containerId, workspaceId, triggerId }) => {
      const res = await tagmanager.accounts.containers.workspaces.triggers.get({
        path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/triggers/${triggerId}`,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_delete_trigger",
    { accountId: z.string(), containerId: z.string(), workspaceId: z.string(), triggerId: z.string() },
    async ({ accountId, containerId, workspaceId, triggerId }) => {
      await tagmanager.accounts.containers.workspaces.triggers.delete({
        path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/triggers/${triggerId}`,
      });
      return { content: [{ type: "text", text: JSON.stringify({ deleted: true }) }] };
    },
  );

  server.tool(
    "gtm_revert_trigger",
    {
      accountId:   z.string(),
      containerId: z.string(),
      workspaceId: z.string(),
      triggerId:   z.string(),
      fingerprint: z.string().optional(),
    },
    async ({ accountId, containerId, workspaceId, triggerId, fingerprint }) => {
      const res = await tagmanager.accounts.containers.workspaces.triggers.revert({
        path:        `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/triggers/${triggerId}`,
        fingerprint,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_list_variables",
    { accountId: z.string(), containerId: z.string(), workspaceId: z.string() },
    async ({ accountId, containerId, workspaceId }) => {
      const res = await tagmanager.accounts.containers.workspaces.variables.list({
        parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data.variable ?? []) }] };
    },
  );

  server.tool(
    "gtm_get_variable",
    { accountId: z.string(), containerId: z.string(), workspaceId: z.string(), variableId: z.string() },
    async ({ accountId, containerId, workspaceId, variableId }) => {
      const res = await tagmanager.accounts.containers.workspaces.variables.get({
        path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/variables/${variableId}`,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_create_variable",
    {
      accountId:   z.string(),
      containerId: z.string(),
      workspaceId: z.string(),
      name:        z.string(),
      type:        z.string(),
      parameter:   z.array(z.record(z.unknown())).optional(),
    },
    async ({ accountId, containerId, workspaceId, name, type, parameter }) => {
      const cleanParameter = parameter?.map((p) => ({
        type: p["type"], key: p["key"], value: p["value"],
        ...(p["list"]            ? { list: p["list"] }                                       : {}),
        ...(p["map"]             ? { map: p["map"] }                                         : {}),
        ...(p["isWeakReference"] !== undefined ? { isWeakReference: p["isWeakReference"] } : {}),
      }));
      const res = await tagmanager.accounts.containers.workspaces.variables.create({
        parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
        requestBody: { name, type, parameter: cleanParameter } as never,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_update_variable",
    {
      accountId:   z.string(),
      containerId: z.string(),
      workspaceId: z.string(),
      variableId:  z.string(),
      name:        z.string().optional(),
      parameter:   z.array(z.record(z.unknown())).optional(),
    },
    async ({ accountId, containerId, workspaceId, variableId, name, parameter }) => {
      const path = `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/variables/${variableId}`;
      const existing = await tagmanager.accounts.containers.workspaces.variables.get({ path });
      const current = existing.data as Record<string, unknown>;
      const cleanParameter = parameter?.map((p) => ({
        type: p["type"], key: p["key"], value: p["value"],
        ...(p["list"]            ? { list: p["list"] }                                       : {}),
        ...(p["map"]             ? { map: p["map"] }                                         : {}),
        ...(p["isWeakReference"] !== undefined ? { isWeakReference: p["isWeakReference"] } : {}),
      }));
      const res = await tagmanager.accounts.containers.workspaces.variables.update({
        path,
        requestBody: {
          ...current,
          ...(name           !== undefined ? { name }                    : {}),
          ...(cleanParameter !== undefined ? { parameter: cleanParameter } : {}),
        } as never,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_delete_variable",
    { accountId: z.string(), containerId: z.string(), workspaceId: z.string(), variableId: z.string() },
    async ({ accountId, containerId, workspaceId, variableId }) => {
      await tagmanager.accounts.containers.workspaces.variables.delete({
        path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/variables/${variableId}`,
      });
      return { content: [{ type: "text", text: JSON.stringify({ deleted: true }) }] };
    },
  );

  server.tool(
    "gtm_revert_variable",
    {
      accountId:   z.string(),
      containerId: z.string(),
      workspaceId: z.string(),
      variableId:  z.string(),
      fingerprint: z.string().optional(),
    },
    async ({ accountId, containerId, workspaceId, variableId, fingerprint }) => {
      const res = await tagmanager.accounts.containers.workspaces.variables.revert({
        path:        `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/variables/${variableId}`,
        fingerprint,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_list_built_in_variables",
    { accountId: z.string(), containerId: z.string(), workspaceId: z.string() },
    async ({ accountId, containerId, workspaceId }) => {
      const res = await tagmanager.accounts.containers.workspaces.built_in_variables.list({
        parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data.builtInVariable ?? []) }] };
    },
  );

  server.tool(
    "gtm_create_built_in_variable",
    { accountId: z.string(), containerId: z.string(), workspaceId: z.string(), type: z.array(z.string()) },
    async ({ accountId, containerId, workspaceId, type }) => {
      const res = await tagmanager.accounts.containers.workspaces.built_in_variables.create({
        parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
        type:   type as never,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data.builtInVariable ?? []) }] };
    },
  );

  server.tool(
    "gtm_delete_built_in_variable",
    { accountId: z.string(), containerId: z.string(), workspaceId: z.string(), type: z.string() },
    async ({ accountId, containerId, workspaceId, type }) => {
      await tagmanager.accounts.containers.workspaces.built_in_variables.delete({
        path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/built_in_variables`,
        type: type as never,
      });
      return { content: [{ type: "text", text: JSON.stringify({ deleted: true }) }] };
    },
  );

  server.tool(
    "gtm_revert_built_in_variable",
    { accountId: z.string(), containerId: z.string(), workspaceId: z.string(), type: z.string() },
    async ({ accountId, containerId, workspaceId, type }) => {
      const res = await tagmanager.accounts.containers.workspaces.built_in_variables.revert({
        path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/built_in_variables`,
        type: type as never,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_list_folders",
    { accountId: z.string(), containerId: z.string(), workspaceId: z.string() },
    async ({ accountId, containerId, workspaceId }) => {
      const res = await tagmanager.accounts.containers.workspaces.folders.list({
        parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data.folder ?? []) }] };
    },
  );

  server.tool(
    "gtm_get_folder",
    { accountId: z.string(), containerId: z.string(), workspaceId: z.string(), folderId: z.string() },
    async ({ accountId, containerId, workspaceId, folderId }) => {
      const res = await tagmanager.accounts.containers.workspaces.folders.get({
        path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/folders/${folderId}`,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_create_folder",
    {
      accountId:   z.string(),
      containerId: z.string(),
      workspaceId: z.string(),
      name:        z.string(),
      notes:       z.string().optional(),
    },
    async ({ accountId, containerId, workspaceId, name, notes }) => {
      const res = await tagmanager.accounts.containers.workspaces.folders.create({
        parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
        requestBody: { name, notes } as never,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_update_folder",
    {
      accountId:   z.string(),
      containerId: z.string(),
      workspaceId: z.string(),
      folderId:    z.string(),
      name:        z.string().optional(),
      notes:       z.string().optional(),
    },
    async ({ accountId, containerId, workspaceId, folderId, name, notes }) => {
      const path = `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/folders/${folderId}`;
      const existing = await tagmanager.accounts.containers.workspaces.folders.get({ path });
      const current = existing.data as Record<string, unknown>;
      const res = await tagmanager.accounts.containers.workspaces.folders.update({
        path,
        requestBody: {
          ...current,
          ...(name  !== undefined ? { name }  : {}),
          ...(notes !== undefined ? { notes } : {}),
        } as never,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_delete_folder",
    { accountId: z.string(), containerId: z.string(), workspaceId: z.string(), folderId: z.string() },
    async ({ accountId, containerId, workspaceId, folderId }) => {
      await tagmanager.accounts.containers.workspaces.folders.delete({
        path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/folders/${folderId}`,
      });
      return { content: [{ type: "text", text: JSON.stringify({ deleted: true }) }] };
    },
  );

  server.tool(
    "gtm_list_folder_entities",
    {
      accountId:   z.string(),
      containerId: z.string(),
      workspaceId: z.string(),
      folderId:    z.string(),
      pageToken:   z.string().optional(),
    },
    async ({ accountId, containerId, workspaceId, folderId, pageToken }) => {
      const res = await tagmanager.accounts.containers.workspaces.folders.entities({
        path:      `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/folders/${folderId}`,
        pageToken,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_move_entities_to_folder",
    {
      accountId:   z.string(),
      containerId: z.string(),
      workspaceId: z.string(),
      folderId:    z.string(),
      tagId:       z.array(z.string()).optional(),
      triggerId:   z.array(z.string()).optional(),
      variableId:  z.array(z.string()).optional(),
    },
    async ({ accountId, containerId, workspaceId, folderId, tagId, triggerId, variableId }) => {
      await tagmanager.accounts.containers.workspaces.folders.move_entities_to_folder({
        path:       `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/folders/${folderId}`,
        tagId:      tagId      as never,
        triggerId:  triggerId  as never,
        variableId: variableId as never,
      });
      return { content: [{ type: "text", text: JSON.stringify({ moved: true }) }] };
    },
  );

  server.tool(
    "gtm_revert_folder",
    {
      accountId:   z.string(),
      containerId: z.string(),
      workspaceId: z.string(),
      folderId:    z.string(),
      fingerprint: z.string().optional(),
    },
    async ({ accountId, containerId, workspaceId, folderId, fingerprint }) => {
      const res = await tagmanager.accounts.containers.workspaces.folders.revert({
        path:        `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/folders/${folderId}`,
        fingerprint,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_list_templates",
    { accountId: z.string(), containerId: z.string(), workspaceId: z.string() },
    async ({ accountId, containerId, workspaceId }) => {
      const res = await tagmanager.accounts.containers.workspaces.templates.list({
        parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data.template ?? []) }] };
    },
  );

  server.tool(
    "gtm_get_template",
    { accountId: z.string(), containerId: z.string(), workspaceId: z.string(), templateId: z.string() },
    async ({ accountId, containerId, workspaceId, templateId }) => {
      const res = await tagmanager.accounts.containers.workspaces.templates.get({
        path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/templates/${templateId}`,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_create_template",
    {
      accountId:    z.string(),
      containerId:  z.string(),
      workspaceId:  z.string(),
      name:         z.string(),
      templateData: z.string(),
    },
    async ({ accountId, containerId, workspaceId, name, templateData }) => {
      const res = await tagmanager.accounts.containers.workspaces.templates.create({
        parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
        requestBody: { name, templateData } as never,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_update_template",
    {
      accountId:    z.string(),
      containerId:  z.string(),
      workspaceId:  z.string(),
      templateId:   z.string(),
      name:         z.string().optional(),
      templateData: z.string().optional(),
    },
    async ({ accountId, containerId, workspaceId, templateId, name, templateData }) => {
      const path = `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/templates/${templateId}`;
      const existing = await tagmanager.accounts.containers.workspaces.templates.get({ path });
      const current = existing.data as Record<string, unknown>;
      const res = await tagmanager.accounts.containers.workspaces.templates.update({
        path,
        requestBody: {
          ...current,
          ...(name         !== undefined ? { name }         : {}),
          ...(templateData !== undefined ? { templateData } : {}),
        } as never,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_delete_template",
    { accountId: z.string(), containerId: z.string(), workspaceId: z.string(), templateId: z.string() },
    async ({ accountId, containerId, workspaceId, templateId }) => {
      await tagmanager.accounts.containers.workspaces.templates.delete({
        path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/templates/${templateId}`,
      });
      return { content: [{ type: "text", text: JSON.stringify({ deleted: true }) }] };
    },
  );

  server.tool(
    "gtm_revert_template",
    {
      accountId:   z.string(),
      containerId: z.string(),
      workspaceId: z.string(),
      templateId:  z.string(),
      fingerprint: z.string().optional(),
    },
    async ({ accountId, containerId, workspaceId, templateId, fingerprint }) => {
      const res = await tagmanager.accounts.containers.workspaces.templates.revert({
        path:        `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/templates/${templateId}`,
        fingerprint,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_import_template_from_gallery",
    {
      accountId:   z.string(),
      containerId: z.string(),
      workspaceId: z.string(),
      owner:       z.string(),
      repository:  z.string(),
      version:     z.string().optional(),
      host:        z.string().optional(),
    },
    async ({ accountId, containerId, workspaceId, owner, repository, version, host }) => {
      const res = await tagmanager.accounts.containers.workspaces.templates.create({
        parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
        requestBody: {
          galleryReference: {
            host:       host ?? "github.com",
            owner,
            repository,
            ...(version !== undefined ? { version } : {}),
          },
        } as never,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_list_transformations",
    { accountId: z.string(), containerId: z.string(), workspaceId: z.string() },
    async ({ accountId, containerId, workspaceId }) => {
      const res = await tagmanager.accounts.containers.workspaces.transformations.list({
        parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data.transformation ?? []) }] };
    },
  );

  server.tool(
    "gtm_get_transformation",
    { accountId: z.string(), containerId: z.string(), workspaceId: z.string(), transformationId: z.string() },
    async ({ accountId, containerId, workspaceId, transformationId }) => {
      const res = await tagmanager.accounts.containers.workspaces.transformations.get({
        path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/transformations/${transformationId}`,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_create_transformation",
    {
      accountId:   z.string(),
      containerId: z.string(),
      workspaceId: z.string(),
      name:        z.string(),
      type:        z.string(),
      parameter:   z.array(z.record(z.unknown())).optional(),
    },
    async ({ accountId, containerId, workspaceId, name, type, parameter }) => {
      const cleanParameter = parameter?.map((p) => ({
        type: p["type"], key: p["key"], value: p["value"],
        ...(p["list"]            ? { list: p["list"] }                                       : {}),
        ...(p["map"]             ? { map: p["map"] }                                         : {}),
        ...(p["isWeakReference"] !== undefined ? { isWeakReference: p["isWeakReference"] } : {}),
      }));
      const res = await tagmanager.accounts.containers.workspaces.transformations.create({
        parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
        requestBody: { name, type, parameter: cleanParameter } as never,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_update_transformation",
    {
      accountId:        z.string(),
      containerId:      z.string(),
      workspaceId:      z.string(),
      transformationId: z.string(),
      name:             z.string().optional(),
      parameter:        z.array(z.record(z.unknown())).optional(),
    },
    async ({ accountId, containerId, workspaceId, transformationId, name, parameter }) => {
      const path = `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/transformations/${transformationId}`;
      const existing = await tagmanager.accounts.containers.workspaces.transformations.get({ path });
      const current = existing.data as Record<string, unknown>;
      const cleanParameter = parameter?.map((p) => ({
        type: p["type"], key: p["key"], value: p["value"],
        ...(p["list"]            ? { list: p["list"] }                                       : {}),
        ...(p["map"]             ? { map: p["map"] }                                         : {}),
        ...(p["isWeakReference"] !== undefined ? { isWeakReference: p["isWeakReference"] } : {}),
      }));
      const res = await tagmanager.accounts.containers.workspaces.transformations.update({
        path,
        requestBody: {
          ...current,
          ...(name           !== undefined ? { name }                      : {}),
          ...(cleanParameter !== undefined ? { parameter: cleanParameter } : {}),
        } as never,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_delete_transformation",
    { accountId: z.string(), containerId: z.string(), workspaceId: z.string(), transformationId: z.string() },
    async ({ accountId, containerId, workspaceId, transformationId }) => {
      await tagmanager.accounts.containers.workspaces.transformations.delete({
        path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/transformations/${transformationId}`,
      });
      return { content: [{ type: "text", text: JSON.stringify({ deleted: true }) }] };
    },
  );

  server.tool(
    "gtm_revert_transformation",
    {
      accountId:        z.string(),
      containerId:      z.string(),
      workspaceId:      z.string(),
      transformationId: z.string(),
      fingerprint:      z.string().optional(),
    },
    async ({ accountId, containerId, workspaceId, transformationId, fingerprint }) => {
      const res = await tagmanager.accounts.containers.workspaces.transformations.revert({
        path:        `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/transformations/${transformationId}`,
        fingerprint,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_list_clients",
    { accountId: z.string(), containerId: z.string(), workspaceId: z.string() },
    async ({ accountId, containerId, workspaceId }) => {
      const res = await tagmanager.accounts.containers.workspaces.clients.list({
        parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data.client ?? []) }] };
    },
  );

  server.tool(
    "gtm_get_client",
    { accountId: z.string(), containerId: z.string(), workspaceId: z.string(), clientId: z.string() },
    async ({ accountId, containerId, workspaceId, clientId }) => {
      const res = await tagmanager.accounts.containers.workspaces.clients.get({
        path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/clients/${clientId}`,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_create_client",
    {
      accountId:   z.string(),
      containerId: z.string(),
      workspaceId: z.string(),
      name:        z.string(),
      type:        z.string(),
      parameter:   z.array(z.record(z.unknown())).optional(),
    },
    async ({ accountId, containerId, workspaceId, name, type, parameter }) => {
      const cleanParameter = parameter?.map((p) => ({
        type: p["type"], key: p["key"], value: p["value"],
        ...(p["list"]            ? { list: p["list"] }                                       : {}),
        ...(p["map"]             ? { map: p["map"] }                                         : {}),
        ...(p["isWeakReference"] !== undefined ? { isWeakReference: p["isWeakReference"] } : {}),
      }));
      const res = await tagmanager.accounts.containers.workspaces.clients.create({
        parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
        requestBody: { name, type, parameter: cleanParameter } as never,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_update_client",
    {
      accountId:   z.string(),
      containerId: z.string(),
      workspaceId: z.string(),
      clientId:    z.string(),
      name:        z.string().optional(),
      parameter:   z.array(z.record(z.unknown())).optional(),
    },
    async ({ accountId, containerId, workspaceId, clientId, name, parameter }) => {
      const path = `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/clients/${clientId}`;
      const existing = await tagmanager.accounts.containers.workspaces.clients.get({ path });
      const current = existing.data as Record<string, unknown>;
      const cleanParameter = parameter?.map((p) => ({
        type: p["type"], key: p["key"], value: p["value"],
        ...(p["list"]            ? { list: p["list"] }                                       : {}),
        ...(p["map"]             ? { map: p["map"] }                                         : {}),
        ...(p["isWeakReference"] !== undefined ? { isWeakReference: p["isWeakReference"] } : {}),
      }));
      const res = await tagmanager.accounts.containers.workspaces.clients.update({
        path,
        requestBody: {
          ...current,
          ...(name           !== undefined ? { name }                      : {}),
          ...(cleanParameter !== undefined ? { parameter: cleanParameter } : {}),
        } as never,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_delete_client",
    { accountId: z.string(), containerId: z.string(), workspaceId: z.string(), clientId: z.string() },
    async ({ accountId, containerId, workspaceId, clientId }) => {
      await tagmanager.accounts.containers.workspaces.clients.delete({
        path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/clients/${clientId}`,
      });
      return { content: [{ type: "text", text: JSON.stringify({ deleted: true }) }] };
    },
  );

  server.tool(
    "gtm_revert_client",
    {
      accountId:   z.string(),
      containerId: z.string(),
      workspaceId: z.string(),
      clientId:    z.string(),
      fingerprint: z.string().optional(),
    },
    async ({ accountId, containerId, workspaceId, clientId, fingerprint }) => {
      const res = await tagmanager.accounts.containers.workspaces.clients.revert({
        path:        `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/clients/${clientId}`,
        fingerprint,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_list_zones",
    { accountId: z.string(), containerId: z.string(), workspaceId: z.string() },
    async ({ accountId, containerId, workspaceId }) => {
      const res = await tagmanager.accounts.containers.workspaces.zones.list({
        parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data.zone ?? []) }] };
    },
  );

  server.tool(
    "gtm_get_zone",
    { accountId: z.string(), containerId: z.string(), workspaceId: z.string(), zoneId: z.string() },
    async ({ accountId, containerId, workspaceId, zoneId }) => {
      const res = await tagmanager.accounts.containers.workspaces.zones.get({
        path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/zones/${zoneId}`,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_create_zone",
    {
      accountId:       z.string(),
      containerId:     z.string(),
      workspaceId:     z.string(),
      name:            z.string(),
      notes:           z.string().optional(),
      boundary:        z.record(z.unknown()).optional(),
      typeRestriction: z.record(z.unknown()).optional(),
      childContainer:  z.array(z.record(z.unknown())).optional(),
    },
    async ({ accountId, containerId, workspaceId, name, notes, boundary, typeRestriction, childContainer }) => {
      const res = await tagmanager.accounts.containers.workspaces.zones.create({
        parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
        requestBody: { name, notes, boundary, typeRestriction, childContainer } as never,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_update_zone",
    {
      accountId:       z.string(),
      containerId:     z.string(),
      workspaceId:     z.string(),
      zoneId:          z.string(),
      name:            z.string().optional(),
      notes:           z.string().optional(),
      boundary:        z.record(z.unknown()).optional(),
      typeRestriction: z.record(z.unknown()).optional(),
      childContainer:  z.array(z.record(z.unknown())).optional(),
    },
    async ({ accountId, containerId, workspaceId, zoneId, name, notes, boundary, typeRestriction, childContainer }) => {
      const path = `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/zones/${zoneId}`;
      const existing = await tagmanager.accounts.containers.workspaces.zones.get({ path });
      const current = existing.data as Record<string, unknown>;
      const res = await tagmanager.accounts.containers.workspaces.zones.update({
        path,
        requestBody: {
          ...current,
          ...(name            !== undefined ? { name }            : {}),
          ...(notes           !== undefined ? { notes }           : {}),
          ...(boundary        !== undefined ? { boundary }        : {}),
          ...(typeRestriction !== undefined ? { typeRestriction } : {}),
          ...(childContainer  !== undefined ? { childContainer }  : {}),
        } as never,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_delete_zone",
    { accountId: z.string(), containerId: z.string(), workspaceId: z.string(), zoneId: z.string() },
    async ({ accountId, containerId, workspaceId, zoneId }) => {
      await tagmanager.accounts.containers.workspaces.zones.delete({
        path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/zones/${zoneId}`,
      });
      return { content: [{ type: "text", text: JSON.stringify({ deleted: true }) }] };
    },
  );

  server.tool(
    "gtm_revert_zone",
    {
      accountId:   z.string(),
      containerId: z.string(),
      workspaceId: z.string(),
      zoneId:      z.string(),
      fingerprint: z.string().optional(),
    },
    async ({ accountId, containerId, workspaceId, zoneId, fingerprint }) => {
      const res = await tagmanager.accounts.containers.workspaces.zones.revert({
        path:        `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/zones/${zoneId}`,
        fingerprint,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_list_gtag_configs",
    { accountId: z.string(), containerId: z.string(), workspaceId: z.string() },
    async ({ accountId, containerId, workspaceId }) => {
      const res = await tagmanager.accounts.containers.workspaces.gtag_config.list({
        parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data.gtagConfig ?? []) }] };
    },
  );

  server.tool(
    "gtm_get_gtag_config",
    { accountId: z.string(), containerId: z.string(), workspaceId: z.string(), gtagConfigId: z.string() },
    async ({ accountId, containerId, workspaceId, gtagConfigId }) => {
      const res = await tagmanager.accounts.containers.workspaces.gtag_config.get({
        path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/gtag_config/${gtagConfigId}`,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_create_gtag_config",
    {
      accountId:   z.string(),
      containerId: z.string(),
      workspaceId: z.string(),
      type:        z.string(),
      parameter:   z.array(z.record(z.unknown())).optional(),
    },
    async ({ accountId, containerId, workspaceId, type, parameter }) => {
      const cleanParameter = parameter?.map((p) => ({
        type: p["type"], key: p["key"], value: p["value"],
        ...(p["list"]            ? { list: p["list"] }                                       : {}),
        ...(p["map"]             ? { map: p["map"] }                                         : {}),
        ...(p["isWeakReference"] !== undefined ? { isWeakReference: p["isWeakReference"] } : {}),
      }));
      const res = await tagmanager.accounts.containers.workspaces.gtag_config.create({
        parent: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
        requestBody: { type, parameter: cleanParameter } as never,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_update_gtag_config",
    {
      accountId:    z.string(),
      containerId:  z.string(),
      workspaceId:  z.string(),
      gtagConfigId: z.string(),
      parameter:    z.array(z.record(z.unknown())).optional(),
    },
    async ({ accountId, containerId, workspaceId, gtagConfigId, parameter }) => {
      const path = `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/gtag_config/${gtagConfigId}`;
      const existing = await tagmanager.accounts.containers.workspaces.gtag_config.get({ path });
      const current = existing.data as Record<string, unknown>;
      const cleanParameter = parameter?.map((p) => ({
        type: p["type"], key: p["key"], value: p["value"],
        ...(p["list"]            ? { list: p["list"] }                                       : {}),
        ...(p["map"]             ? { map: p["map"] }                                         : {}),
        ...(p["isWeakReference"] !== undefined ? { isWeakReference: p["isWeakReference"] } : {}),
      }));
      const res = await tagmanager.accounts.containers.workspaces.gtag_config.update({
        path,
        requestBody: {
          ...current,
          ...(cleanParameter !== undefined ? { parameter: cleanParameter } : {}),
        } as never,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_delete_gtag_config",
    { accountId: z.string(), containerId: z.string(), workspaceId: z.string(), gtagConfigId: z.string() },
    async ({ accountId, containerId, workspaceId, gtagConfigId }) => {
      await tagmanager.accounts.containers.workspaces.gtag_config.delete({
        path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}/gtag_config/${gtagConfigId}`,
      });
      return { content: [{ type: "text", text: JSON.stringify({ deleted: true }) }] };
    },
  );

  server.tool(
    "gtm_list_user_permissions",
    { accountId: z.string() },
    async ({ accountId }) => {
      const res = await tagmanager.accounts.user_permissions.list({
        parent: `accounts/${accountId}`,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data.userPermission ?? []) }] };
    },
  );

  server.tool(
    "gtm_get_user_permission",
    { accountId: z.string(), userPermissionId: z.string() },
    async ({ accountId, userPermissionId }) => {
      const res = await tagmanager.accounts.user_permissions.get({
        path: `accounts/${accountId}/user_permissions/${userPermissionId}`,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_create_user_permission",
    {
      accountId:       z.string(),
      emailAddress:    z.string(),
      accountAccess:   z.record(z.unknown()),
      containerAccess: z.array(z.record(z.unknown())).optional(),
    },
    async ({ accountId, emailAddress, accountAccess, containerAccess }) => {
      const res = await tagmanager.accounts.user_permissions.create({
        parent: `accounts/${accountId}`,
        requestBody: { emailAddress, accountAccess, containerAccess } as never,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_update_user_permission",
    {
      accountId:        z.string(),
      userPermissionId: z.string(),
      accountAccess:    z.record(z.unknown()).optional(),
      containerAccess:  z.array(z.record(z.unknown())).optional(),
    },
    async ({ accountId, userPermissionId, accountAccess, containerAccess }) => {
      const path = `accounts/${accountId}/user_permissions/${userPermissionId}`;
      const existing = await tagmanager.accounts.user_permissions.get({ path });
      const current = existing.data as Record<string, unknown>;
      const res = await tagmanager.accounts.user_permissions.update({
        path,
        requestBody: {
          ...current,
          ...(accountAccess   !== undefined ? { accountAccess }   : {}),
          ...(containerAccess !== undefined ? { containerAccess } : {}),
        } as never,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data) }] };
    },
  );

  server.tool(
    "gtm_delete_user_permission",
    { accountId: z.string(), userPermissionId: z.string() },
    async ({ accountId, userPermissionId }) => {
      await tagmanager.accounts.user_permissions.delete({
        path: `accounts/${accountId}/user_permissions/${userPermissionId}`,
      });
      return { content: [{ type: "text", text: JSON.stringify({ deleted: true }) }] };
    },
  );

  server.tool(
    "gtm_list_versions",
    { accountId: z.string(), containerId: z.string() },
    async ({ accountId, containerId }) => {
      const res = await tagmanager.accounts.containers.versions.list({
        parent: `accounts/${accountId}/containers/${containerId}`,
      });
      return { content: [{ type: "text", text: JSON.stringify(res.data.containerVersion ?? []) }] };
    },
  );

  server.tool(
    "gtm_publish_version",
    {
      accountId: z.string(), containerId: z.string(), workspaceId: z.string(),
      name: z.string().optional(), notes: z.string().optional(),
    },
    async ({ accountId, containerId, workspaceId, name, notes }) => {
      const createRes = await tagmanager.accounts.containers.workspaces.create_version({
        path: `accounts/${accountId}/containers/${containerId}/workspaces/${workspaceId}`,
        requestBody: { name, notes } as never,
      });
      const versionId = (createRes.data as { containerVersion?: { containerVersionId?: string } })
        .containerVersion?.containerVersionId;
      if (!versionId) throw new Error("Version creation failed");

      const publishRes = await tagmanager.accounts.containers.versions.publish({
        path: `accounts/${accountId}/containers/${containerId}/versions/${versionId}`,
      });
      return { content: [{ type: "text", text: JSON.stringify(publishRes.data) }] };
    },
  );

  return server;
}

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Health check
app.get("/health", (_req, res) => res.json({ ok: true, service: "mcp-gtm" }));

// Tool schemas endpoint (used by backend to build OpenAI function definitions)
app.get("/tool-schemas", (req, res) => {
  if (req.headers["x-internal-secret"] !== INTERNAL_SECRET) {
    res.status(403).json({ error: "Forbidden" });
    return;
  }
  res.json(TOOL_SCHEMAS);
});

// MCP endpoint — stateless per-request
app.post("/mcp", async (req, res) => {
  const accessToken = checkSecret(req, res);
  if (!accessToken) return;

  const server = buildMcpServer(accessToken);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  res.on("close", () => transport.close());

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(PORT, () => console.log(`GTM MCP server listening on port ${PORT}`));
