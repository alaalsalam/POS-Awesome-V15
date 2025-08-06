import { defineStore } from "pinia";

export const usePosProfileStore = defineStore("posProfile", {
        state: () => ({
                posProfile: null,
                posOpeningShift: null,
        }),
        actions: {
                registerPosData(data) {
                        if (data?.pos_profile) {
                                this.posProfile = data.pos_profile;
                        }
                        if (data?.pos_opening_shift) {
                                this.posOpeningShift = data.pos_opening_shift;
                        }
                },
                setPosProfile(profile) {
                        this.posProfile = profile;
                },
                setPosOpeningShift(shift) {
                        this.posOpeningShift = shift;
                },
                clear() {
                        this.posProfile = null;
                        this.posOpeningShift = null;
                },
        },
});

