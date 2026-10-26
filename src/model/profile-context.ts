import { emptyProfile, type UserProfile } from "../shared/profile";
// Renderer cache only: the main process owns persistence and silent rewrites.
let current = emptyProfile();
export const learnerProfile = () => current;
export const setLearnerProfile = (profile: UserProfile) => {
  current = profile;
};
