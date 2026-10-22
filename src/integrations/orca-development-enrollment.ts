import { publishOrcaEnrollment, type OrcaEnrollmentPublicationInput } from "./orca-enrollment-publication.js";

/** Task-local development enrollment is not an execution grant or human authentication. */
export async function registerOrcaDevelopmentEnrollment(input:OrcaEnrollmentPublicationInput){
  const enrollment=await publishOrcaEnrollment(input,"development");
  return {...enrollment,phase:"DOING" as const,permissionIssued:false as const,canReply:false as const};
}
