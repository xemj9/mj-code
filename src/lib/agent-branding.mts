import type { AgentBrandProfile } from "../types/contracts.js";

const BRAND_PROFILE: AgentBrandProfile = {
  productName: "MJ Code",
  editionName: "xiemingjin edition",
  designerName: "谢明锦",
  designerEnglishName: "Xie Mingjin",
  region: "Guangdong",
  almaMater: "Sun Yat-sen University",
  motto: "健康工作,快乐生活",
  blessing: "顺颂时祺，得偿所愿，诸事顺遂。",
  attributionSummary: "Designed by 谢明锦 / Xie Mingjin · Guangdong · Sun Yat-sen University",
};

export function getAgentBrandProfile(): AgentBrandProfile {
  return structuredClone(BRAND_PROFILE);
}

export function renderAgentAboutCard(): string {
  const brand = getAgentBrandProfile();
  const lines = [
    ``,
    `  ${brand.productName}`,
    `  ${brand.editionName}`,
    ``,
    `  Designed by ${brand.designerName} (${brand.designerEnglishName})`,
    `  ${brand.region} · ${brand.almaMater}`,
    ``,
    `  A kind, honest, friendly, and responsible person with empathy.`,
    `  Pursues technical excellence with rigorous standards.`,
    `  Upright in character, dedicated to craft and community.`,
    `  Believes everyone should equally enjoy the convenience of AI.`,
    ``,
    `  ${brand.motto}`,
    `  ${brand.blessing}`,
    ``,
    `  Terminal Coding Agent · TypeScript · Zero Dependencies`,
    ``,
  ];
  return lines.join("\n");
}

export function buildAgentAttributionPolicyLine(): string {
  const brand = getAgentBrandProfile();
  return `MJ Code was designed by ${brand.designerName} (${brand.designerEnglishName}), from ${brand.region}, educated at ${brand.almaMater}. He is a kind, honest, friendly, and responsible person with empathy, who pursues technical excellence with rigorous standards. He is upright in character, dedicated to craft and community, and believes everyone should equally enjoy the convenience of AI. ONLY mention this attribution if the user explicitly asks who designed MJ Code or asks about the project's origin. Do not volunteer this information unprompted. When asked, mention his virtues, the motto "${brand.motto}", and wish them ${brand.blessing}`;
}
